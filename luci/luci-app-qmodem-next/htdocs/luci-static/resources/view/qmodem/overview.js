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

/* ---- network topology, recreating the HigoOS NetworkTopology chart ---- */
var TOPO_ICONS = {
	internet: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/><path d="M8 2.5c1.8 1.6 2.8 3.4 2.8 5.5S9.8 11.9 8 13.5C6.2 11.9 5.2 10.1 5.2 8S6.2 4.1 8 2.5Z"/>',
	router: '<rect x="2.5" y="9" width="11" height="3.5" rx="1.2"/><path d="M5.5 6.8a3.6 3.6 0 0 1 5 0"/><path d="M4 5a5.8 5.8 0 0 1 8 0"/><circle cx="5.2" cy="10.8" r="0.6" fill="currentColor" stroke="none"/><circle cx="8" cy="10.8" r="0.6" fill="currentColor" stroke="none"/><circle cx="10.8" cy="10.8" r="0.6" fill="currentColor" stroke="none"/>',
	wired: '<rect x="3" y="2.5" width="10" height="7" rx="1.2"/><path d="M6 12.8h4"/><path d="M8 9.8v3"/>',
	wireless: '<path d="M3.2 6.2a7 7 0 0 1 9.6 0"/><path d="M5.2 8.4a4.2 4.2 0 0 1 5.6 0"/><path d="M7 10.6a1.7 1.7 0 0 1 2 0"/><circle cx="8" cy="12.6" r="0.8" fill="currentColor" stroke="none"/>',
	cpe: '<path d="M3.5 12.5h9"/><path d="M8 3v9.5"/><path d="M5.2 6.2a4 4 0 0 1 5.6 0"/><path d="M6.4 8.2a2.2 2.2 0 0 1 3.2 0"/>'
};

var TOPO_COLORS = { online: '#10b981', offline: '#ef4444', warning: '#f59e0b' };

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
	});
}

function textWidth(s, fs) {
	var w = 0;
	for (var i = 0; i < s.length; i++)
		w += s.charCodeAt(i) > 255 ? fs : fs * 0.62;
	return w;
}

/* vendor table mapping Mbps on an edge to its stroke width */
function topoMbps(v) {
	var f = Number(v);
	if (!(f > 0))
		f = 0;
	return f <= 0.1 ? 4.6 : f < 1 ? 5.4 : f < 5 ? 6.8 : f < 20 ? 8.7 : f < 80 ? 10.8 : 13.2;
}

/* flatten the tree and place nodes like the vendor chart: depth drives
   the horizontal position while siblings spread vertically (percent) */
function topoLayout(root, mbps) {
	var flat = [], order = 0;

	(function walk(n, depth, parentKey) {
		var key = parentKey ? parentKey + '/' + n.id : 'root';
		flat.push({ key: key, depth: depth, order: order++, parentKey: parentKey, node: n });
		(n.children || []).forEach(function(c) { walk(c, depth + 1, key); });
	})(root, 0, null);

	var maxDepth = 0, byDepth = {};
	flat.forEach(function(f) {
		if (f.depth > maxDepth)
			maxDepth = f.depth;
		(byDepth[f.depth] = byDepth[f.depth] || []).push(f);
	});

	var pos = {}, nodes = [];
	Object.keys(byDepth).forEach(function(d) {
		var q = byDepth[d], n = q.length, dr = maxDepth === 0 ? 0 : d / maxDepth;
		q.forEach(function(f, ge) {
			var ie = n <= 1 ? 0.5 : ge / (n - 1);
			pos[f.key] = { node: f.node, order: f.order, depth: +d,
				x: 10 + dr * 74, y: 12 + ie * 76, levelIndex: ge, levelCount: n };
			nodes.push(pos[f.key]);
		});
	});

	var edges = [];
	flat.forEach(function(f) {
		if (!f.parentKey)
			return;
		var p = pos[f.parentKey], c = pos[f.key],
			de = c.levelCount <= 1 ? 0 : (c.levelIndex - (c.levelCount - 1) / 2) / ((c.levelCount - 1) / 2),
			ge = p.depth === 0 ? 0.22 : 0.14,
			cv = +(de * ge).toFixed(3);

		if (Math.abs(cv) < 0.025)
			cv = (c.levelIndex % 2 === 0 ? -1 : 1) * ge / 2.6;

		edges.push({
			sp: [p.x, p.y], tp: [c.x, c.y], curv: cv,
			mbps: c.node.id === 'internet' ? mbps : 0,
			online: (p.node.status || 'online') !== 'offline' && (c.node.status || 'online') !== 'offline'
		});
	});

	nodes.sort(function(a, b) { return a.order - b.order; });
	return { nodes: nodes, edges: edges };
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
		    lastStats = null, cur = null, curVendor = null, topoHost = null;

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
				/* rpc expect unwrapping already yields the interface array */
				var list = Array.isArray(d) ? d : ((d && d.interface) || []),
					st = null;

				list.forEach(function(i) {
					if (!st && (i.interface === cur.ifname || i.interface === cur.id))
						st = i;
				});

				var ip = null, gw = null, gw6 = null, dns = [], ip6 = [],
					prefix6 = null, dev = null;

				function collect(e) {
					if (!e)
						return;

					if (dev == null)
						dev = e.l3_device || e.device || null;
					if (ip == null && e['ipv4-address'] && e['ipv4-address'].length)
						ip = e['ipv4-address'][0].address + '/' + e['ipv4-address'][0].mask;
					if (e.route)
						e.route.forEach(function(r) {
							if (!r)
								return;
							if (gw == null && r.target === '0.0.0.0' && r.mask === 0)
								gw = r.nexthop || r.gateway || null;
							if (gw6 == null && r.target === '::' && r.mask === 0)
								gw6 = r.nexthop || r.gateway || null;
						});
					if (e['dns-server'])
						e['dns-server'].forEach(function(a) {
							var s = (typeof a === 'string') ? a : (a && a.address);
							if (s && dns.indexOf(s) === -1)
								dns.push(s);
						});
					if (e['ipv6-address'])
						e['ipv6-address'].forEach(function(a) {
							if (a && a.address && ip6.indexOf(a.address + '/' + a.mask) === -1)
								ip6.push(a.address + '/' + a.mask);
						});
					/* like network.js getIP6Addrs: prefix assignment local
					   addresses count as interface addresses as well */
					if (e['ipv6-prefix-assignment'])
						e['ipv6-prefix-assignment'].forEach(function(p) {
							var la = p && p['local-address'];
							if (la && la.address && ip6.indexOf(la.address + '/' + la.mask) === -1)
								ip6.push(la.address + '/' + la.mask);
						});
					if (!prefix6 && e['ipv6-prefix'] && e['ipv6-prefix'].length &&
					    e['ipv6-prefix'][0].address)
						prefix6 = e['ipv6-prefix'][0].address + '/' + e['ipv6-prefix'][0].mask;
				}

				collect(st);

				/* mirror luci-mod-dashboard getWAN6Networks: when our own
				   interface carries no IPv6 at all, fall back to the
				   interface holding the IPv6 default route */
				if (!ip6.length && gw6 == null && prefix6 == null) {
					var best = null, bestMetric = 2000000000;

					list.forEach(function(i) {
						var has6 = false, m;

						if (!i || i === st || !i.route)
							return;
						i.route.forEach(function(r) {
							if (r && r.target === '::' && r.mask === 0)
								has6 = true;
						});
						if (!has6)
							return;
						m = (typeof i.metric === 'number') ? i.metric : 0;
						if (m < bestMetric) {
							bestMetric = m;
							best = i;
						}
					});

					if (best) {
						dev = best.l3_device || best.device || dev;
						collect(best);
					}
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
					setField(refs.fPrefix6, 'IPv6 前綴', prefix6);
				});
			}).catch(function() { });
		}

		function updateDevices() {
			/* merge dhcp leases with the wifi association lists like
			   luci-mod-dashboard: stations contribute signal strength and
			   transferred traffic, leases contribute hostname and address */
			var stations = [], hints = null;

			L.resolveDefault(network.getHostHints(), null).then(function(h) {
				hints = h;
				return L.resolveDefault(network.getWifiNetworks(), []);
			}).catch(function() { return []; }).then(function(nets) {
				return Promise.all(nets.map(function(net) {
					return L.resolveDefault(net.getAssocList(), []).then(function(list) {
						return { ssid: net.getActiveSSID(), list: list };
					}).catch(function() { return { ssid: null, list: [] }; });
				}));
			}).then(function(assocs) {
				assocs.forEach(function(a) {
					a.list.forEach(function(bss) {
						if (bss && bss.mac)
							stations.push({ mac: bss.mac, signal: bss.signal,
								noise: bss.noise, ssid: a.ssid,
								tx: bss.tx ? bss.tx.bytes : null,
								rx: bss.rx ? bss.rx.bytes : null });
					});
				});
				return L.resolveDefault(callLuciDHCPLeases(), {});
			}).then(function(res) {
				var leases = Array.isArray(res.dhcp_leases) ? res.dhcp_leases : [],
					byMac = {}, order = [], rows = [], n = 0;

				function touch(mac) {
					var k = String(mac).toLowerCase();
					if (!byMac[k]) {
						byMac[k] = { mac: String(mac).toUpperCase() };
						order.push(k);
					}
					return byMac[k];
				}

				stations.forEach(function(s) {
					var e = touch(s.mac);
					e.signal = s.signal;
					e.noise = s.noise;
					e.tx = s.tx;
					e.rx = s.rx;
					e.ssid = s.ssid;
				});
				leases.forEach(function(d) {
					if (!d || (!d.ipaddr && !d.hostname))
						return;
					var e = touch(d.macaddr || '00:00:00:00:00:00');
					if (d.hostname)
						e.hostname = d.hostname;
					if (d.ipaddr)
						e.ip = d.ipaddr;
				});

				/* same quality formula as luci-mod-dashboard */
				function sigCell(e) {
					if (e.signal == null)
						return E('td', { 'class': 'td' }, '--');
					var noise = (typeof e.noise === 'number') ? e.noise : -90,
						q = 100 * ((e.signal - noise) / (-30 - noise));
					q = Math.max(0, Math.min(100, Math.round(q)));
					return E('td', { 'class': 'td' }, [
						E('span', { 'style': 'color:' + (q < 25 ? '#c94040' :
							(q < 50 ? '#e0a020' : '#23b45a')) },
							e.signal + ' dBm（' + q + '%）')
					]);
				}

				function flowCell(e) {
					if (e.tx == null && e.rx == null)
						return E('td', { 'class': 'td' }, '--');
					return E('td', { 'class': 'td' },
						'↓ ' + '%.2mB'.format(e.tx || 0) + '　↑ ' + '%.2mB'.format(e.rx || 0));
				}

				order.forEach(function(k) {
					var e = byMac[k],
						name = e.hostname || (hints ? hints.getHostnameByMACAddr(e.mac) : null);
					rows.push(E('tr', { 'class': 'tr cbi-rowstyle-' + (n % 2 ? 2 : 1) }, [
						E('td', { 'class': 'td' }, name || '(未命名)'),
						E('td', { 'class': 'td' }, e.ip || '--'),
						E('td', { 'class': 'td' }, e.mac),
						sigCell(e),
						flowCell(e)
					]));
					n++;
				});
				if (!rows.length)
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', 'colspan': '5', 'style': 'text-align:center;color:#888' }, '無連線裝置')
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
						E('td', { 'class': 'td' }, chan ? chan + ' (' + (freq || '?') + ' GHz)' : '--'),
						E('td', { 'class': 'td' }, net.getActiveBSSID() || '--')
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

		function topoName() {
			if (topoHost != null)
				return Promise.resolve(topoHost);
			return fs.read('/proc/sys/kernel/hostname').then(function(h) {
				topoHost = String(h).trim() || '路由器';
				return topoHost;
			}).catch(function() {
				topoHost = '路由器';
				return topoHost;
			});
		}

		function updateTopo() {
			if (!cur)
				return;

			Promise.all([
				topoName(),
				callInterfaceDump().catch(function() { return []; }),
				L.resolveDefault(callLuciDHCPLeases(), {}),
				L.resolveDefault(network.getWifiNetworks(), []).catch(function() { return []; })
			]).then(function(r) {
				return Promise.all(r[3].map(function(net) {
					var f = parseFloat(net.getFrequency() || '0');
					return L.resolveDefault(net.getAssocList(), []).then(function(l) {
						return { band: f >= 5 ? '5g' : '24g', list: l };
					}).catch(function() { return { band: '24g', list: [] }; });
				})).then(function(assocs) {
					renderTopo(r[0], r[1], assocs);
				});
			}).catch(function() { });
		}

		function renderTopo(d, leaseRes, assocs) {
			var list = Array.isArray(d) ? d : ((d && d.interface) || []),
				leases = (leaseRes && Array.isArray(leaseRes.dhcp_leases)) ? leaseRes.dhcp_leases : [],
				wan = null, lan = null;

			list.forEach(function(i) {
				if (!i)
					return;
				if (i.interface === cur.ifname || i.interface === cur.id)
					wan = i;
				else if (i.interface === 'lan')
					lan = i;
			});

			function firstAddr(e, key) {
				var a = e && e[key];
				return (a && a.length && a[0].address) ? a[0].address : null;
			}

			var stMac = {}, stations = [];
			assocs.forEach(function(a) {
				a.list.forEach(function(b) {
					if (!b || !b.mac || stMac[b.mac.toLowerCase()])
						return;
					stMac[b.mac.toLowerCase()] = true;
					stations.push({ mac: b.mac, band: a.band });
				});
			});

			var wired = [], groups = { '24g': [], '5g': [] };
			leases.forEach(function(e) {
				if (!e || (!e.ipaddr && !e.hostname))
					return;
				var k = (e.macaddr || '').toLowerCase(), st = null;
				if (k && stMac[k])
					stations.forEach(function(x) { if (x.mac.toLowerCase() === k) st = x; });
				if (st) {
					st.hostname = e.hostname;
					st.ip = e.ipaddr;
					return;
				}
				wired.push({ mac: e.macaddr, hostname: e.hostname, ip: e.ipaddr });
			});
			stations.forEach(function(s) { groups[s.band].push(s); });

			function devNode(p, n, x) {
				return { id: p + n, name: x.hostname || '(未命名)', type: 'cpe',
					status: 'online', ip: x.ip, mac: x.mac };
			}

			var kids = [{ id: 'internet', name: 'Internet', type: 'internet',
					status: (wan && wan.up) ? 'online' : 'offline',
					ip: firstAddr(wan, 'ipv4-address') }];

			if (wired.length)
				kids.push({ id: 'wired', name: '有線設備 (' + wired.length + ')', type: 'wired',
					status: 'online', children: wired.map(function(x, n) { return devNode('w', n, x); }) });
			if (groups['24g'].length)
				kids.push({ id: 'wifi24', name: 'WiFi 2.4G (' + groups['24g'].length + ')', type: 'wireless',
					status: 'online', children: groups['24g'].map(function(x, n) { return devNode('a2', n, x); }) });
			if (groups['5g'].length)
				kids.push({ id: 'wifi5', name: 'WiFi 5G (' + groups['5g'].length + ')', type: 'wireless',
					status: 'online', children: groups['5g'].map(function(x, n) { return devNode('a5', n, x); }) });

			var root = { id: 'router', name: topoHost || '路由器', type: 'router',
					status: 'online', ip: firstAddr(lan, 'ipv4-address'), children: kids },
				last = hist.length ? hist[hist.length - 1] : null,
				lay = topoLayout(root, last ? last.down + last.up : 0),
				W = 1000, H = 420, svg = [];

			function px(p) { return [p[0] / 100 * W, p[1] / 100 * H]; }
			function n2(v) { return Math.round(v * 10) / 10; }

			lay.edges.forEach(function(e) {
				var dx = e.tp[0] - e.sp[0], dy = e.tp[1] - e.sp[1],
					wv = Math.max(2.2, Math.min(12, Math.abs(dy) * 0.55 + Math.abs(dx) * 0.12)) * e.curv,
					s = px(e.sp), a = px([e.sp[0] + dx * 0.22, e.sp[1]]),
					b1 = px([e.sp[0] + dx * 0.42, e.sp[1] + wv * 0.68]),
					b2 = px([e.sp[0] + dx * 0.78, e.tp[1] + wv * 0.22]),
					t = px(e.tp),
					path = 'M' + n2(s[0]) + ' ' + n2(s[1]) + ' L' + n2(a[0]) + ' ' + n2(a[1]) +
						' C' + n2(b1[0]) + ' ' + n2(b1[1]) + ' ' + n2(b2[0]) + ' ' + n2(b2[1]) +
						' ' + n2(t[0]) + ' ' + n2(t[1]),
					w = topoMbps(e.mbps);

				svg.push('<path d="' + path + '" fill="none" stroke-linecap="round" stroke="rgba(140,166,194,0.12)" stroke-width="' + n2(w + 6.1) + '"/>');
				svg.push('<path d="' + path + '" fill="none" stroke-linecap="round" stroke="rgba(126,151,182,0.22)" stroke-width="' + n2(w + 3.2) + '"/>');
				svg.push('<path d="' + path + '" fill="none" stroke-linecap="round" stroke="rgba(112,136,164,0.34)" stroke-width="' + n2(Math.max(2.6, w * 0.78)) + '"/>');

				/* traffic particles flowing down (green) and up (sky) */
				if (e.online)
					for (var k = 0; k < 2; k++) {
						svg.push('<circle r="2" fill="#10b981" opacity="0.7"><animateMotion dur="7s" begin="' + (-k * 3.5) + 's" repeatCount="indefinite" path="' + path + '"/></circle>');
						svg.push('<circle r="2" fill="#0284c7" opacity="0.7"><animateMotion dur="7s" begin="' + (-k * 3.5 - 1.75) + 's" repeatCount="indefinite" path="' + path + '" keyPoints="1;0" keyTimes="0;1" calcMode="linear"/></circle>');
					}
			});

			lay.nodes.forEach(function(nd) {
				var p = px([nd.x, nd.y]),
					col = TOPO_COLORS[nd.node.status || 'online'] || TOPO_COLORS.online,
					r = nd.node.type === 'router' ? 8 : 6.5,
					name = String(nd.node.name || '').replace(/[{}|]/g, ' ').trim(),
					lw = textWidth(name, 12) + 46,
					lx = p[0] + r + 6,
					tip = [nd.node.name || '', '類型: ' + (nd.node.type || ''),
						nd.node.ip ? 'IP: ' + nd.node.ip : null,
						nd.node.mac ? 'MAC: ' + nd.node.mac : null,
						'狀態: ' + (nd.node.status || 'online')];

				svg.push('<g class="cpe-topo-node" data-tip="' + esc(tip.filter(function(x) { return x != null; }).join('\n')) + '">');
				svg.push('<circle cx="' + n2(p[0]) + '" cy="' + n2(p[1]) + '" r="' + r + '" fill="' + col + '" stroke="#e2e8f0" stroke-width="2"/>');
				svg.push('<rect x="' + n2(lx) + '" y="' + n2(p[1] - 13) + '" width="' + n2(lw) + '" height="26" rx="6" fill="rgba(248,250,252,0.98)" stroke="#e2e8f0"/>');
				svg.push('<g transform="translate(' + n2(lx + 7) + ',' + n2(p[1] - 7) + ') scale(0.875)" stroke="#334155" color="#334155" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round">' + (TOPO_ICONS[nd.node.type] || TOPO_ICONS.cpe) + '</g>');
				svg.push('<text x="' + n2(lx + 27) + '" y="' + n2(p[1] + 4) + '" font-size="12" font-weight="600" fill="#334155">' + esc(name) + '</text>');
				svg.push('</g>');
			});

			refs.topoSvg.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:' + H + 'px;overflow:visible;display:block">' + svg.join('') + '</svg>';

			/* hover tooltip like the vendor chart */
			Array.prototype.forEach.call(refs.topoSvg.querySelectorAll('g.cpe-topo-node'), function(g) {
				g.addEventListener('mouseenter', function() {
					var lines = g.getAttribute('data-tip').split('\n'),
						cb = refs.topoBox.getBoundingClientRect(),
						bb = g.getBoundingClientRect();
					refs.topoTip.innerHTML = '<strong>' + esc(lines[0]) + '</strong>' +
						lines.slice(1).map(function(l) { return '<br/>' + esc(l); }).join('');
					refs.topoTip.style.left = Math.max(0, bb.left - cb.left) + 'px';
					refs.topoTip.style.top = (bb.bottom - cb.top + 6) + 'px';
					refs.topoTip.style.display = 'block';
				});
				g.addEventListener('mouseleave', function() {
					refs.topoTip.style.display = 'none';
				});
			});
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
		refs.fPrefix6 = field('IPv6 前綴', null);

		container.appendChild(E('div', { 'class': 'cpe-section' }, [
			E('h3', '網路連線資訊'),
			E('div', { 'class': 'cpe-fields' }, [refs.fIp, refs.fGw, refs.fDns, refs.fIp6, refs.fGw6, refs.fPrefix6])
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
						E('th', { 'class': 'th' }, 'MAC'),
						E('th', { 'class': 'th' }, '訊號強度'),
						E('th', { 'class': 'th' }, '已使用流量')
					])
				]),
				refs.devBody
			]),
			refs.devCount
		]));

		refs.topoSvg = E('div', { 'style': 'width:100%' });
		refs.topoTip = E('div', { 'style': 'position:absolute;z-index:30;display:none;pointer-events:none;white-space:nowrap;background:rgba(15,23,42,0.9);border:1px solid #334155;border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.6;color:#f1f5f9' });
		refs.topoBox = E('div', { 'style': 'position:relative;width:100%' }, [refs.topoSvg, refs.topoTip]);
		container.appendChild(E('div', { 'class': 'cpe-section' }, [
			E('h3', '網路拓撲'),
			refs.topoBox
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
		poll.add(updateTopo, 10);
		poll.add(updateWifi, 15);
		updateModem();
		updateSpeed();
		updateThermal();
		updateNet();
		updateDevices();
		updateTopo();
		updateWifi();

		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
