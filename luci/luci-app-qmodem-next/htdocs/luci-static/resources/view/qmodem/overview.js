'use strict';
'require rpc';
'require uci';
'require poll';
'require fs';
'require network';
'require view';
'require qmodem.mcc-mnc as mccmnc';

document.head.appendChild(E('link', {
	'rel': 'stylesheet',
	'type': 'text/css',
	'href': L.resource('qmodem/cpe-dashboard.css')
}));

/* qmodem 3.0.x ubus API (rpcd), all methods take config_section */
var callBaseInfo = rpc.declare({ object: 'qmodem', method: 'base_info', params: ['config_section'], expect: {} });
var callCellInfo = rpc.declare({ object: 'qmodem', method: 'cell_info', params: ['config_section'], expect: {} });
var callSimInfo = rpc.declare({ object: 'qmodem', method: 'sim_info', params: ['config_section'], expect: {} });
var callNetworkInfo = rpc.declare({ object: 'qmodem', method: 'network_info', params: ['config_section'], expect: {} });
var callGetStats = rpc.declare({ object: 'qmodem', method: 'get_stats', params: ['config_section'], expect: {} });
var callDialStatus = rpc.declare({ object: 'qmodem', method: 'dial_status', params: ['config_section'], expect: {} });
var callInterfaceDump = rpc.declare({ object: 'network.interface', method: 'dump', expect: { interface: [] } });
var callLuciDHCPLeases = rpc.declare({ object: 'luci-rpc', method: 'getDHCPLeases', expect: { '': {} } });
var callGetCopyright = rpc.declare({ object: 'qmodem', method: 'get_copyright', params: ['config_section'], expect: {} });
var callInterfaceStatus = rpc.declare({ object: 'network.interface', method: 'status', params: ['interface'], expect: {} });
var callRcReload = rpc.declare({ object: 'rc', method: 'init', params: ['name'], extra: { 'mode': 'reload' }, expect: {} });

/* uci.commit()/reload() were removed in newer LuCI; keep compat */
function uciCommit(conf) {
	if (typeof uci.commit === 'function')
		return Promise.resolve(uci.commit(conf));
	return uci.save().then(function() { return uci.apply(10); });
}

function uciReload(conf) {
	if (typeof uci.reload === 'function')
		return Promise.resolve(uci.reload(conf));
	uci.unload(conf);
	return uci.load(conf);
}

var HISTORY_LEN = 60;
var GRADE_LABELS = ['優秀', '良好', '普通', '較差'];
var GRADE_CLASS = ['good', 'ok', 'mid', 'bad'];
var SIG_TITLES = {
	'RSRP': 'RSRP 參考訊號接收功率',
	'RSRQ': 'RSRQ 參考訊號接收品質',
	'SINR': 'SINR 訊號與干擾雜訊比'
};

/* keys already shown in dedicated cards/fields; the rest are rendered generically */
var CONSUMED_KEYS = {
	'RSRP': 1, 'RSRQ': 1, 'SINR': 1, 'network_mode': 1,
	'MCC': 1, 'MNC': 1, 'TAC': 1, 'Cell ID': 1, 'Physical Cell ID': 1,
	'ARFCN': 1, 'EARFCN': 1, 'NR-ARFCN': 1, 'UARFCN': 1,
	'Band': 1, 'DL Bandwidth': 1, 'UL Bandwidth': 1,
	'ISP': 1, 'connect_status': 1
};

/* E-UTRA band by downlink EARFCN range (3GPP TS 36.101 Table 5.5.1-1),
   used as fallback when the modem reports an empty band field */
var LTE_BANDS = [
	[0, 599, '1'], [600, 1199, '2'], [1200, 1949, '3'], [1950, 2399, '4'],
	[2400, 2649, '5'], [2650, 2749, '6'], [2750, 3449, '7'], [3450, 3799, '8'],
	[3800, 4149, '9'], [4150, 4749, '10'], [4750, 4949, '11'], [5010, 5179, '12'],
	[5180, 5279, '13'], [5280, 5379, '14'], [5730, 5849, '17'], [5850, 5999, '18'],
	[6000, 6149, '19'], [6150, 6449, '20'], [6450, 6599, '21'], [6600, 7399, '22'],
	[7500, 7699, '23'], [7700, 8039, '24'], [8040, 8689, '25'], [8690, 9039, '26'],
	[9040, 9209, '27'], [9210, 9659, '28'], [9660, 9769, '29'], [9770, 9869, '30'],
	[9870, 9919, '31'], [9920, 10359, '32'], [36000, 36199, '33'], [36200, 36349, '34'],
	[36350, 36949, '35'], [36950, 37549, '36'], [37550, 37749, '37'], [37750, 38249, '38'],
	[38250, 38649, '39'], [38650, 39649, '40'], [39650, 41589, '41'], [41590, 43589, '42'],
	[43590, 45589, '43'], [45590, 46589, '44'], [46590, 46789, '45'], [46790, 54539, '46'],
	[54540, 55239, '47'], [55240, 56739, '48'], [56740, 58239, '49'], [58240, 59089, '50'],
	[59090, 59139, '51'], [59140, 60139, '52'], [60140, 60254, '53'], [60255, 60304, '54'],
	[65536, 66435, '65'], [66436, 67335, '66'], [67336, 67535, '67'], [67536, 67835, '68'],
	[67836, 68335, '69'], [68336, 68585, '70'], [68586, 68935, '71'], [68936, 68985, '72'],
	[68986, 69035, '73'], [69036, 69465, '74'], [69466, 70315, '75'], [70316, 70365, '76'],
	[70366, 70545, '85'], [70546, 70595, '87'], [70596, 70645, '88'], [70646, 70655, '103'],
	[70656, 70705, '106'], [73386, 73485, '111']
];

function bandFromEarfcn(earfcn) {
	var e = toNum(earfcn);
	if (e == null)
		return null;
	for (var i = 0; i < LTE_BANDS.length; i++)
		if (e >= LTE_BANDS[i][0] && e <= LTE_BANDS[i][1])
			return LTE_BANDS[i][2];
	return null;
}

/* collect entries not covered by dedicated cards -> generic key/value fields;
   warning_message entries are collected separately */
function extraFields(lists) {
	var seen = {}, fields = [], warnings = [];
	lists.forEach(function(list) {
		list.forEach(function(e) {
			if (!e || !e.key || seen[e.key] || CONSUMED_KEYS[e.key])
				return;
			seen[e.key] = 1;
			if (e.type === 'warning_message') {
				if (e.value != null && String(e.value) !== '')
					warnings.push(String(e.value));
				return;
			}
			var val = (e.value == null) ? null : String(e.value);
			if (val === '')
				val = null;
			if (val == null)
				return;
			if (e.type === 'progress_bar' && e.max_value != null)
				val += ' / ' + String(e.max_value) + (e.unit ? ' ' + e.unit : '');
			fields.push(E('div', { 'class': 'cpe-field' }, [
				E('div', { 'class': 'cpe-field-label' }, _(e.full_name || e.key)),
				E('div', { 'class': 'cpe-field-value' }, val)
			]));
		});
	});
	return { fields: fields, warnings: warnings };
}

function entriesOf(res) {
	return (res && Array.isArray(res.modem_info)) ? res.modem_info : [];
}

function entryOf(list, key) {
	for (var i = 0; i < list.length; i++) {
		if (list[i] && list[i].key === key)
			return list[i];
	}
	return null;
}

function valueOf(list, key) {
	var e = entryOf(list, key);
	if (e && e.value != null && String(e.value) !== '')
		return String(e.value);
	return null;
}

function toNum(v) {
	if (v == null)
		return null;
	var n = parseFloat(v);
	return isNaN(n) ? null : n;
}

function truthy(v) {
	return v === true || v === 1 || v === '1' || v === 'true';
}

function formatRate(bps) {
	if (bps == null)
		return '--';
	if (bps >= 1e6)
		return (bps / 1e6).toFixed(2);
	if (bps >= 1e3)
		return (bps / 1e3).toFixed(1);
	return String(Math.round(bps));
}

function rateUnit(bps) {
	if (bps == null)
		return 'bps';
	if (bps >= 1e6)
		return 'Mbps';
	if (bps >= 1e3)
		return 'Kbps';
	return 'bps';
}

function formatBytes(b) {
	if (b == null)
		return '--';
	if (b >= 1073741824)
		return (b / 1073741824).toFixed(2) + ' GB';
	if (b >= 1048576)
		return (b / 1048576).toFixed(2) + ' MB';
	if (b >= 1024)
		return (b / 1024).toFixed(1) + ' KB';
	return Math.round(b) + ' B';
}

/* thresholds identical to qmodem.js formatSignal() */
function gradeRsrp(v) { return v >= -80 ? 0 : v >= -90 ? 1 : v >= -100 ? 2 : 3; }
function gradeRsrq(v) { return v >= -10 ? 0 : v >= -15 ? 1 : v >= -20 ? 2 : 3; }
function gradeSinr(v) { return v >= 20 ? 0 : v >= 13 ? 1 : v >= 0 ? 2 : 3; }

function overallGrade(vals) {
	var g = [];
	for (var i = 0; i < vals.length; i++) {
		if (vals[i] != null)
			g.push(vals[i]);
	}
	if (!g.length)
		return null;
	return Math.max.apply(null, g);
}

function signalLevel(grade) {
	if (grade == null)
		return 0;
	return [5, 4, 3, 1][grade];
}

function netMode(v) {
	var s = String(v || '').toUpperCase();
	if (s.indexOf('NR5G_SA') >= 0 || s === 'SA')
		return '5G SA';
	if (s.indexOf('NR5G_NSA') >= 0 || s === 'NSA')
		return '5G NSA';
	if (s.indexOf('NR') >= 0)
		return '5G';
	if (s.indexOf('LTE') >= 0)
		return '4G LTE';
	if (s.indexOf('WCDMA') >= 0 || s.indexOf('UMTS') >= 0 || s.indexOf('HSPA') >= 0)
		return '3G';
	if (s.indexOf('GSM') >= 0 || s.indexOf('EDGE') >= 0)
		return '2G';
	return v || '--';
}

function badge(label, cls) {
	return E('span', { 'class': 'cpe-badge ' + (cls || '') }, label);
}

function field(label, value) {
	return E('div', { 'class': 'cpe-field' }, [
		E('div', { 'class': 'cpe-field-label' }, label),
		E('div', { 'class': 'cpe-field-value' }, (value == null || value === '') ? '--' : String(value))
	]);
}

function setField(el, label, value) {
	el.firstChild.textContent = label;
	el.lastChild.textContent = (value == null || value === '') ? '--' : String(value);
}

function card(title, valueNodes, sub) {
	var n = [E('div', { 'class': 'cpe-card-title' }, title)];
	if (valueNodes)
		n = n.concat(valueNodes);
	if (sub)
		n.push(E('div', { 'class': 'cpe-card-sub' }, sub));
	return E('div', { 'class': 'cpe-card' }, n);
}

function barsEl(level, grade) {
	var spans = [];
	for (var i = 1; i <= 5; i++) {
		var cls = '';
		if (i <= level) {
			cls = 'on';
			if (grade >= 1 && grade <= 2)
				cls += ' ok';
			else if (grade >= 3)
				cls += ' bad';
		}
		spans.push(E('span', { 'class': cls }));
	}
	return E('div', { 'class': 'cpe-bars' }, spans);
}

var SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs) {
	var el = document.createElementNS(SVG_NS, name);
	for (var k in attrs)
		if (attrs.hasOwnProperty(k))
			el.setAttribute(k, attrs[k]);
	return el;
}

function sparkSvg() {
	var svg = svgEl('svg', { 'class': 'cpe-spark', 'viewBox': '0 0 600 160', 'preserveAspectRatio': 'none' });
	for (var y = 40; y < 160; y += 40)
		svg.appendChild(svgEl('line', { 'class': 'grid', 'x1': 0, 'y1': y, 'x2': 600, 'y2': y }));
	svg.appendChild(svgEl('polyline', { 'class': 'down', 'points': '' }));
	svg.appendChild(svgEl('polyline', { 'class': 'up', 'points': '' }));
	return svg;
}

function sparkPoints(hist, key, scale) {
	var pts = [];
	for (var i = 0; i < hist.length; i++) {
		var v = hist[i][key] || 0;
		var x = (i * (600 / (HISTORY_LEN - 1))).toFixed(1);
		var y = (155 - (v / scale) * 150).toFixed(1);
		pts.push(x + ',' + y);
	}
	return pts.join(' ');
}

function domContent(el, node) {
	while (el.firstChild)
		el.removeChild(el.firstChild);
	if (node != null)
		el.appendChild(node);
}

function fillTbody(tbody, rows) {
	while (tbody.firstChild)
		tbody.removeChild(tbody.firstChild);
	rows.forEach(function(r) {
		tbody.appendChild(r);
	});
}

var thermal = { temp: null, pwm: null, probed: false };

/* locate the cpu temperature and pwm fan hwmon nodes, preferring the
   cpu_thermal and pwmfan sensor names */
function probeThermal() {
	if (thermal.probed)
		return Promise.resolve(thermal);
	thermal.probed = true;

	return fs.list('/sys/class/hwmon').then(function(entries) {
		var chain = Promise.resolve();
		var fbTemp = null, fbPwm = null;

		entries.forEach(function(ent) {
			if (!ent || !ent.name || !/^hwmon\d+$/i.test(ent.name))
				return;
			chain = chain.then(function() {
				return fs.read('/sys/class/hwmon/' + ent.name + '/name').then(function(name) {
					name = String(name).trim();
					if (name === 'cpu_thermal' && !thermal.temp)
						thermal.temp = '/sys/class/hwmon/' + ent.name + '/temp1_input';
					else if (name === 'pwmfan' && !thermal.pwm)
						thermal.pwm = '/sys/class/hwmon/' + ent.name + '/pwm1';
					else if (name !== 'cpu_thermal' && name !== 'pwmfan') {
						if (!fbTemp) fbTemp = '/sys/class/hwmon/' + ent.name + '/temp1_input';
						if (!fbPwm) fbPwm = '/sys/class/hwmon/' + ent.name + '/pwm1';
					}
				}).catch(function() { });
			});
		});

		return chain.then(function() {
			if (!thermal.temp) thermal.temp = fbTemp;
			if (!thermal.pwm) thermal.pwm = fbPwm;
			return thermal;
		});
	}).catch(function() { return thermal; });
}

return view.extend({
	title: 'CPE 管理',

	load: function() {
		return uci.load('qmodem').then(function() {
			var list = [];
			uci.sections('qmodem', 'modem-device', function(s) {
				if (s.at_port)
					var ifn = (s.alias && s.alias !== '-') ? s.alias : s['.name'];
					list.push({ id: s['.name'], ifname: ifn, name: ifn.toUpperCase(), paused: s.state === 'disabled' });
			});
			return list;
		});
	},

	render: function(modems) {
		var refs = { sigCards: {} }, hist = [], peakDown = 0, peakUp = 0,
		    lastStats = null, cur = null, curVendor = null;

		if (!modems || !modems.length)
			return E('div', { 'class': 'cbi-map' }, [
				E('h3', 'CPE 管理'),
				E('div', { 'class': 'alert-message warning' }, '未找到已啟用的 qmodem 模組設定，請先安裝 qmodem 並完成設定。')
			]);

		function resetSpeedState() {
			hist = [];
			peakDown = 0;
			peakUp = 0;
			lastStats = null;
		}

		function readCounters() {
			/* netifd interface counters first (qmodem names the interface
			   after the modem alias or section), then fall back to the
			   modem-side AT traffic counters */
			var names = [];
			if (cur.ifname)
				names.push(cur.ifname);
			if (cur.id && cur.id !== cur.ifname)
				names.push(cur.id);

			function tryNext(i) {
				if (i >= names.length)
					return Promise.resolve(null);
				return callInterfaceStatus(names[i]).then(function(st) {
					if (st && st.statistics) {
						var rx = toNum(st.statistics.rx_bytes),
						    tx = toNum(st.statistics.tx_bytes);
						if (rx != null && tx != null)
							return { rx: rx, tx: tx };
					}
					return tryNext(i + 1);
				}).catch(function() { return tryNext(i + 1); });
			}

			return tryNext(0).then(function(c) {
				if (c)
					return c;
				return callGetStats(cur.id).then(function(st) {
					/* quectel.sh parses AT+QGDNRCNT as "<tx>,<rx>" but the
					   modules actually answer "<rx>,<tx>", so the ubus field
					   names are swapped: total_rx_bytes holds TX and vice versa */
					if (st && st.available && st.total_rx_bytes != null && st.total_tx_bytes != null) {
						var swap = curVendor !== 'fibocom';
						return { rx: toNum(swap ? st.total_tx_bytes : st.total_rx_bytes),
						         tx: toNum(swap ? st.total_rx_bytes : st.total_tx_bytes) };
					}
					return null;
				}).catch(function() { return null; });
			});
		}

		function updateSpeed() {
			if (!cur)
				return;

			readCounters().then(function(c) {
				var now = Date.now() / 1000,
				    down = null, up = null;

				if (c && c.rx != null && c.tx != null) {
					if (lastStats) {
						var dt = now - lastStats.t;
						if (dt > 0) {
							down = Math.max(0, (c.rx - lastStats.rx) / dt * 8);
							up = Math.max(0, (c.tx - lastStats.tx) / dt * 8);
						}
					}
					lastStats = { t: now, rx: c.rx, tx: c.tx };
				}
				else {
					lastStats = null;
				}

				if (down != null) {
					hist.push({ down: down / 1e6, up: (up || 0) / 1e6 });
					if (hist.length > HISTORY_LEN)
						hist.shift();
					if (down > peakDown)
						peakDown = down;
					if (up > peakUp)
						peakUp = up;
				}

				setField(refs.downCard, '目前下載速率', formatRate(down) + ' ' + rateUnit(down));
				setField(refs.upCard, '目前上傳速率', formatRate(up) + ' ' + rateUnit(up));
				setField(refs.peakDown, '峰值速率 下行', formatRate(peakDown) + ' ' + rateUnit(peakDown));
				setField(refs.peakUp, '峰值速率 上行', formatRate(peakUp) + ' ' + rateUnit(peakUp));

				var s = 0.02;
				for (var i = 0; i < hist.length; i++)
					s = Math.max(s, hist[i].down, hist[i].up);
				refs.sparkDown.setAttribute('points', sparkPoints(hist, 'down', s));
				refs.sparkUp.setAttribute('points', sparkPoints(hist, 'up', s));
			}).catch(function() {
				lastStats = null;
				setField(refs.downCard, '目前下載速率', null);
				setField(refs.upCard, '目前上傳速率', null);
			});
		}

		function updateThermal() {
			probeThermal().then(function() {
				return Promise.all([
					thermal.temp ? fs.read(thermal.temp).catch(function() { return null; }) : Promise.resolve(null),
					thermal.pwm ? fs.read(thermal.pwm).catch(function() { return null; }) : Promise.resolve(null)
				]);
			}).then(function(r) {
				var temp = r[0] != null ? Math.round(parseInt(r[0], 10) / 1000) : null;
				var pwm = r[1] != null ? parseInt(r[1], 10) : null;
				if (isNaN(temp)) temp = null;
				if (isNaN(pwm) || pwm < 0) pwm = null;

				setField(refs.tempCard, 'CPU 溫度', temp != null ? temp + ' °C' : null);
				refs.tempCard.lastChild.setAttribute('style',
					temp == null ? '' : (temp >= 80 ? 'color:#c94040' : temp >= 70 ? 'color:#eb8c28' : 'color:#23b45a'));
				setField(refs.fanCard, '風扇轉速',
					pwm != null ? Math.round(pwm / 255 * 100) + ' %（PWM ' + pwm + '）' : null);
			}).catch(function() { });
		}

		function updateNet() {
			if (!cur)
				return;

			/* like luci-mod-dashboard: read the interface state from the
			   netifd dump; the default route lives in the dump route array
			   with a nexthop field, kernel IPv6 addresses are read from
			   /proc/net/if_inet6 as a fallback */
			callInterfaceDump().then(function(d) {
				var list = (d && d.interface) || [], st = null;
				list.forEach(function(i) {
					if (!st && (i.interface === cur.ifname || i.interface === cur.id))
						st = i;
				});
				return st;
			}).then(function(st) {
				var ip = null, gw = null, gw6 = null, dns = [], ip6 = [], dev = null;

				function routeNexthop(r) {
					return r.nexthop || r.gateway || null;
				}

				if (st) {
					dev = st.l3_device || st.device || null;
					if (st['ipv4-address'] && st['ipv4-address'].length)
						ip = st['ipv4-address'][0].address + '/' + st['ipv4-address'][0].mask;
					if (st.route)
						st.route.forEach(function(r) {
							if (!r)
								return;
							if (gw == null && r.target === '0.0.0.0' && r.mask === 0)
								gw = routeNexthop(r);
							if (gw6 == null && r.target === '::' && r.mask === 0)
								gw6 = routeNexthop(r);
						});
					if (st['dns-server'])
						st['dns-server'].forEach(function(d) {
							var a = (typeof d === 'string') ? d : (d && d.address);
							if (a)
								dns.push(a);
						});
					if (st['ipv6-address'])
						st['ipv6-address'].forEach(function(a) {
							if (a && a.address)
								ip6.push(a.address + '/' + a.mask);
						});
				}

				function hexToIp6(h) {
					var g = [];
					for (var i = 0; i < 8; i++)
						g.push(parseInt(h.substr(i * 4, 4), 16).toString(16));
					return g.join(':');
				}

				function findIpv6() {
					if (!dev || ip6.length)
						return Promise.resolve(ip6);
					return fs.read('/proc/net/if_inet6').then(function(data) {
						var out = [];
						String(data).trim().split('\n').forEach(function(l) {
							var p = l.trim().split(/\s+/);
							/* <hex addr> <plen> <scope> <flags> <ifname> */
							if (p.length < 5 || p[4] !== dev || parseInt(p[2], 16) !== 0)
								return;
							out.push(hexToIp6(p[0]) + '/' + parseInt(p[1], 10));
						});
						return out;
					}).catch(function() { return []; });
				}

				findIpv6().then(function(v6) {
					setField(refs.fIp, 'IP 位址', ip);
					setField(refs.fGw, '預設閘道', gw);
					setField(refs.fDns, 'DNS 伺服器', dns.length ? dns.join('、') : null);
					setField(refs.fIp6, 'IPv6 位址', v6.length ? v6.join('、') : null);
					setField(refs.fGw6, 'IPv6 閘道', gw6);
				});
			}).catch(function() { });
		}

		function updateDevices() {
			L.resolveDefault(callLuciDHCPLeases(), {}).then(function(res) {
				var rows = [], n = 0;
				for (var mac in res) {
					if (!res.hasOwnProperty(mac) || !res[mac])
						continue;
					var d = res[mac];
					if (!d.ipv4 && !d.hostname)
						continue;
					rows.push(E('tr', { 'class': 'tr cbi-rowstyle-' + (n % 2 ? 2 : 1) }, [
						E('td', { 'class': 'td' }, d.hostname || '(未命名)'),
						E('td', { 'class': 'td' }, d.ipv4 || '--'),
						E('td', { 'class': 'td' }, d.macaddr || mac)
					]));
					n++;
				}
				if (!rows.length)
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', 'colspan': '3', 'style': 'text-align:center;color:#888' }, '無連線裝置')
					]));
				fillTbody(refs.devBody, rows);
				refs.devCount.textContent = '共 ' + n + ' 台裝置';
			}).catch(function() { });
		}

		function updateWifi() {
			/* network.js self-initialises lazily; only flush its cache so
			   the poll picks up fresh wireless state */
			var prep = (typeof network.flushCache === 'function')
				? L.resolveDefault(network.flushCache(), null) : Promise.resolve();
			prep.then(function() {
				return L.resolveDefault(network.getWifiNetworks(), []);
			}).then(function(nets) {
				var rows = [], n = 0;
				nets.sort(function(a, b) { return L.naturalCompare(a.getWifiDeviceName(), b.getWifiDeviceName()); });
				nets.forEach(function(net) {
					var chan = net.getChannel(), freq = net.getFrequency();
					rows.push(E('tr', { 'class': 'tr cbi-rowstyle-' + (n % 2 ? 2 : 1) }, [
						E('td', { 'class': 'td' }, net.getWifiDeviceName() || '--'),
						E('td', { 'class': 'td' }, net.getActiveSSID() || '?'),
						E('td', { 'class': 'td' }, [
							E('span', { 'style': 'color:' + (net.isDisabled() ? '#c94040' : '#23b45a') },
								net.isDisabled() ? '關閉' : '啟用')
						]),
						E('td', { 'class': 'td' }, chan ? chan + ' (' + (freq ? (freq / 1000).toFixed(3) : '?') + ' GHz)' : '--'),
						E('td', { 'class': 'td' }, net.getBSSID() || '--')
					]));
					n++;
				});
				if (!rows.length)
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', 'colspan': '5', 'style': 'text-align:center;color:#888' }, '無無線網路')
					]));
				fillTbody(refs.wifiBody, rows);
			}).catch(function() { });
		}

		function updateModem() {
			if (!cur)
				return;

			Promise.all([
				callBaseInfo(cur.id), callCellInfo(cur.id), callSimInfo(cur.id),
				callNetworkInfo(cur.id), callGetStats(cur.id), callDialStatus(cur.id)
			]).then(function(r) {
				var base = entriesOf(r[0]), cell = entriesOf(r[1]), sim = entriesOf(r[2]),
				    net = entriesOf(r[3]), stats = r[4] || {}, dial = r[5] || {};

				curVendor = (valueOf(base, 'manufacturer') || '').toLowerCase();

				domContent(refs.err, null);

				var rsrp = toNum(valueOf(cell, 'RSRP')),
				    rsrq = toNum(valueOf(cell, 'RSRQ')),
				    sinr = toNum(valueOf(cell, 'SINR'));
				var mode = valueOf(cell, 'network_mode') || valueOf(net, 'network_mode') || valueOf(base, 'network_mode');
				var isp = valueOf(sim, 'ISP'), ispName = null;
				if (isp) {
					var ispDigits = String(isp).replace(/\D/g, '');
					if (ispDigits.length >= 5)
						ispName = mccmnc.lookup(ispDigits.slice(0, 3), ispDigits.slice(3));
				}
				var gR = rsrp != null ? gradeRsrp(rsrp) : null,
				    gQ = rsrq != null ? gradeRsrq(rsrq) : null,
				    gS = sinr != null ? gradeSinr(sinr) : null;
				var gAll = overallGrade([gR, gQ, gS]);

				domContent(refs.bars, barsEl(signalLevel(gAll), gAll));
				refs.sigValue.textContent = signalLevel(gAll) + '/5';
				domContent(refs.sigBadge, gAll == null ? badge('無訊號', 'mid') : badge(GRADE_LABELS[gAll], GRADE_CLASS[gAll]));

				refs.modeValue.textContent = netMode(mode);
				refs.modeSub.textContent = mode || '未註冊';
				domContent(refs.modeBadge, badge(netMode(mode), (mode && String(mode).toUpperCase().indexOf('NR') >= 0) ? 'good' : 'ok'));

				if (isp) {
					var ispBadge = badge(ispName || isp, '');
					ispBadge.title = 'ISP / PLMN: ' + isp;
					domContent(refs.ispBadge, ispBadge);
				}

				domContent(refs.dialBadge, truthy(dial.running) ? badge('已撥號', 'good') : badge('未撥號', 'bad'));

				var cs = valueOf(base, 'connect_status');
				refs.connSub.textContent = cs ? '模組狀態: ' + cs : '';

				function sigCard(key, val, unit, grade) {
					var v = refs.sigCards[key];
					if (!v)
						return;
					v.value.textContent = val == null ? '--' : String(val);
					v.unit.textContent = unit ? ' ' + unit : '';
					domContent(v.badge, grade == null ? badge('無資料', 'mid') : badge(GRADE_LABELS[grade], GRADE_CLASS[grade]));
				}
				sigCard('RSRP', rsrp, 'dBm', gR);
				sigCard('RSRQ', rsrq, 'dB', gQ);
				sigCard('SINR', sinr, 'dB', gS);

				setField(refs.fMode, '網路模式', netMode(mode));
				var mccV = valueOf(cell, 'MCC'), mncV = valueOf(cell, 'MNC');
				var opName = mccmnc.lookup(mccV, mncV);
				setField(refs.fMcc, '營運商', opName || ((mccV || '--') + ' / ' + (mncV || '--')));
				refs.fMcc.lastChild.title = 'MCC / MNC: ' + (mccV || '--') + ' / ' + (mncV || '--');
				setField(refs.fTac, 'TAC', valueOf(cell, 'TAC'));
				setField(refs.fPci, 'PCI', valueOf(cell, 'Physical Cell ID'));
				setField(refs.fCell, '小區 ID', valueOf(cell, 'Cell ID'));
				setField(refs.fArfcn, '下行頻點 (ARFCN)', valueOf(cell, 'ARFCN') || valueOf(cell, 'EARFCN') || valueOf(cell, 'NR-ARFCN') || valueOf(cell, 'UARFCN'));
				var bandV = valueOf(cell, 'Band') || bandFromEarfcn(valueOf(cell, 'EARFCN') || valueOf(cell, 'ARFCN'));
				setField(refs.fBand, '頻段 (Band)', bandV);
				setField(refs.fDl, '下行頻寬', valueOf(cell, 'DL Bandwidth'));
				setField(refs.fUl, '上行頻寬', valueOf(cell, 'UL Bandwidth'));

				if (truthy(stats.available)) {
					refs.traffic.style.display = '';
					/* quectel.sh parses AT+QGDNRCNT with the directions swapped */
					var rxBytes = curVendor === 'quectel' ? stats.total_tx_bytes : stats.total_rx_bytes,
					    txBytes = curVendor === 'quectel' ? stats.total_rx_bytes : stats.total_tx_bytes;
					setField(refs.tRx, '累計下行流量', formatBytes(toNum(rxBytes)));
					setField(refs.tTx, '累計上行流量', formatBytes(toNum(txBytes)));
				}
				else {
					refs.traffic.style.display = 'none';
				}

				var extra = extraFields([base, sim, net, cell]);
				domContent(refs.warnBox, extra.warnings.length
					? E('div', { 'class': 'alert-message warning' }, extra.warnings.join('； ')) : null);
				while (refs.infoBox.firstChild)
					refs.infoBox.removeChild(refs.infoBox.firstChild);
				extra.fields.forEach(function(f) { refs.infoBox.appendChild(f); });
				refs.info.style.display = extra.fields.length ? '' : 'none';
			}).catch(function(e) {
				domContent(refs.err, E('div', { 'class': 'alert-message warning' },
					'讀取模組資料失敗: ' + (e && e.message ? e.message : e) + '（請確認 qmodem 已執行，且目前使用者具有權限）'));
			});
		}

		function sigCardEl(key) {
			var value = E('span'), unit = E('small'), badgeEl = E('span');
			refs.sigCards[key] = { value: value, unit: unit, badge: badgeEl };
			return card(SIG_TITLES[key], [
				E('div', { 'class': 'cpe-card-value' }, value, unit),
				badgeEl
			]);
		}

		function refreshPauseUI() {
			var paused = !!(cur && cur.paused);
			pauseBtn.textContent = paused ? '恢復管理' : '暫停管理';
			domContent(refs.pauseBadge, paused ? badge('已暫停管理', 'bad') : null);
		}

		var pauseBtn = E('button', { 'class': 'cbi-button cbi-button-action' }, '暫停管理');
		pauseBtn.addEventListener('click', function() {
			if (!cur || pauseBtn.disabled)
				return;
			pauseBtn.disabled = true;
			var op = cur.paused ? uci.unset('qmodem', cur.id, 'state') : uci.set('qmodem', cur.id, 'state', 'disabled');
			Promise.resolve(op).then(function() {
				return uciCommit('qmodem');
			}).then(function() {
				return callRcReload('qmodem_network');
			}).then(function() {
				cur.paused = !cur.paused;
				return uciReload('qmodem');
			}).catch(function(e) {
				domContent(refs.err, E('div', { 'class': 'alert-message warning' },
					'切換失敗: ' + (e && e.message ? e.message : e) + '（請確認目前使用者具有寫入權限）'));
			}).then(function() {
				pauseBtn.disabled = false;
				refreshPauseUI();
				setTimeout(updateModem, 3000);
			});
		});

		var container = E('div', { 'class': 'cpe-wrap' });

		var toolbar = E('div', { 'class': 'cpe-toolbar' });
		var select = E('select', { 'class': 'cbi-input-select' });
		modems.forEach(function(m) {
			select.appendChild(E('option', { 'value': m.id }, m.name + (m.paused ? ' (已暫停)' : '')));
		});
		refs.dialBadge = E('span');
		refs.modeBadge = E('span');
		refs.ispBadge = E('span');
		refs.pauseBadge = E('span');
		toolbar.appendChild(select);
		toolbar.appendChild(refs.dialBadge);
		toolbar.appendChild(refs.modeBadge);
		toolbar.appendChild(refs.ispBadge);
		toolbar.appendChild(pauseBtn);
		toolbar.appendChild(refs.pauseBadge);
		container.appendChild(toolbar);

		refs.err = E('div');
		container.appendChild(refs.err);

		refs.warnBox = E('div');
		container.appendChild(refs.warnBox);

		refs.connSub = E('div', { 'class': 'cpe-card-sub' });
		container.appendChild(refs.connSub);

		refs.bars = E('div');
		refs.sigValue = E('span');
		refs.sigBadge = E('span');
		refs.modeValue = E('span');
		refs.modeSub = E('div', { 'class': 'cpe-card-sub' });
		refs.downCard = field('目前下載速率', null);
		refs.upCard = field('目前上傳速率', null);
		refs.tempCard = field('CPU 溫度', null);
		refs.fanCard = field('風扇轉速', null);

		container.appendChild(E('div', { 'class': 'cpe-cards' }, [
			card('訊號強度', [
				E('div', { 'class': 'cpe-card-value' }, refs.bars, refs.sigValue),
				refs.sigBadge
			]),
			card('網路類型', [E('div', { 'class': 'cpe-card-value' }, refs.modeValue)], refs.modeSub),
			card('即時速率', [refs.downCard, refs.upCard]),
			card('裝置溫度', [refs.tempCard, refs.fanCard])
		]));

		refs.fIp = field('IP 位址', null);
		refs.fGw = field('預設閘道', null);
		refs.fDns = field('DNS 伺服器', null);
		refs.fIp6 = field('IPv6 位址', null);
		refs.fGw6 = field('IPv6 閘道', null);

		container.appendChild(E('div', { 'class': 'cpe-section' }, [
			E('h3', '網路連線資訊'),
			E('div', { 'class': 'cpe-fields' }, [refs.fIp, refs.fGw, refs.fDns, refs.fIp6, refs.fGw6])
		]));

		refs.devBody = E('tbody');
		refs.devCount = E('span', { 'class': 'cpe-card-sub', 'style': 'margin-top:8px' });
		container.appendChild(E('div', { 'class': 'cpe-section' }, [
			E('h3', '已連線裝置'),
			E('table', { 'class': 'table' }, [
				E('thead', [
					E('tr', { 'class': 'tr' }, [
						E('th', { 'class': 'th' }, '主機名稱'),
						E('th', { 'class': 'th' }, 'IP 位址'),
						E('th', { 'class': 'th' }, 'MAC')
					])
				]),
				refs.devBody
			]),
			refs.devCount
		]));

		refs.wifiBody = E('tbody');
		container.appendChild(E('div', { 'class': 'cpe-section' }, [
			E('h3', 'WIFI 資訊'),
			E('table', { 'class': 'table' }, [
				E('thead', [
					E('tr', { 'class': 'tr' }, [
						E('th', { 'class': 'th' }, '無線電'),
						E('th', { 'class': 'th' }, 'SSID'),
						E('th', { 'class': 'th' }, '狀態'),
						E('th', { 'class': 'th' }, '頻道'),
						E('th', { 'class': 'th' }, 'BSSID')
					])
				]),
				refs.wifiBody
			])
		]));

		var speed = sparkSvg();
		refs.sparkDown = speed.getElementsByTagName('polyline')[0];
		refs.sparkUp = speed.getElementsByTagName('polyline')[1];
		refs.peakDown = field('峰值速率 下行', null);
		refs.peakUp = field('峰值速率 上行', null);

		container.appendChild(E('div', { 'class': 'cpe-section' }, [
			E('h3', '詳細訊號參數'),
			E('div', { 'class': 'cpe-cards' }, [sigCardEl('RSRP'), sigCardEl('RSRQ'), sigCardEl('SINR')]),
			E('div', { 'class': 'cpe-quality-legend' }, [
				badge('優秀', 'good'), badge('良好', 'ok'), badge('普通', 'mid'), badge('較差', 'bad'),
				E('span', '　顏色用於綜合評估目前訊號狀態，資料基於 RSRP / RSRQ / SINR 分級。')
			])
		]));

		container.appendChild(E('div', { 'class': 'cpe-section' }, [
			E('h3', '即時速率'),
			speed,
			E('div', { 'class': 'cpe-legend' }, [
				E('span', [E('i', { 'class': 'down' }), '下行']),
				E('span', [E('i', { 'class': 'up' }), '上行'])
			]),
			E('div', { 'class': 'cpe-fields' }, [refs.peakDown, refs.peakUp])
		]));

		refs.fMode = field('網路模式', null);
		refs.fMcc = field('營運商', null);
		refs.fTac = field('TAC', null);
		refs.fPci = field('PCI', null);
		refs.fCell = field('小區 ID', null);
		refs.fArfcn = field('下行頻點 (ARFCN)', null);
		refs.fBand = field('頻段 (Band)', null);
		refs.fDl = field('下行頻寬', null);
		refs.fUl = field('上行頻寬', null);

		container.appendChild(E('div', { 'class': 'cpe-section' }, [
			E('h3', '小區資訊'),
			E('div', { 'class': 'cpe-fields' }, [
				refs.fMode, refs.fMcc, refs.fTac, refs.fPci, refs.fCell,
				refs.fArfcn, refs.fBand, refs.fDl, refs.fUl
			])
		]));

		refs.infoBox = E('div', { 'class': 'cpe-fields' });
		refs.info = E('div', { 'class': 'cpe-section' }, [
			E('h3', '模組與 SIM 資訊'),
			refs.infoBox
		]);
		container.appendChild(refs.info);

		refs.tRx = field('累計下行流量', null);
		refs.tTx = field('累計上行流量', null);
		refs.traffic = E('div', { 'class': 'cpe-section' }, [
			E('h3', '流量統計'),
			E('div', { 'class': 'cpe-fields' }, [refs.tRx, refs.tTx])
		]);
		container.appendChild(refs.traffic);

		refs.copyright = E('div', { 'class': 'cpe-card-sub', 'style': 'margin-top:14px' });
		container.appendChild(refs.copyright);

		function updateCopyright() {
			if (!cur)
				return;
			callGetCopyright(cur.id).then(function(c) {
				var parts = [];
				if (c && c.copyright) {
					for (var k in c.copyright)
						parts.push(_(k) + ': ' + c.copyright[k]);
				}
				refs.copyright.textContent = parts.join('　|　');
			}).catch(function() { refs.copyright.textContent = ''; });
		}

		function selectModem(id) {
			cur = null;
			for (var i = 0; i < modems.length; i++) {
				if (modems[i].id === id)
					cur = modems[i];
			}
			resetSpeedState();
			refreshPauseUI();
			updateCopyright();
			updateModem();
			updateSpeed();
			updateNet();
		}

		select.addEventListener('change', function() { selectModem(select.value); });
		cur = modems[0];
		refreshPauseUI();
		updateCopyright();

		poll.add(updateSpeed, 2);
		poll.add(updateModem, 5);
		poll.add(updateThermal, 5);
		poll.add(updateNet, 5);
		poll.add(updateDevices, 10);
		poll.add(updateWifi, 15);
		updateModem();
		updateSpeed();
		updateThermal();
		updateNet();
		updateDevices();
		updateWifi();

		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
