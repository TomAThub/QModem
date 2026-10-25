'use strict';
'require rpc';
'require uci';
'require poll';
'require fs';
'require network';
'require view';

document.head.appendChild(E('link', {
	'rel': 'stylesheet',
	'type': 'text/css',
	'href': L.resource('qmodem/cpe-dashboard.css')
}));

var callInterfaceDump = rpc.declare({ object: 'network.interface', method: 'dump', expect: { interface: [] } });
var callLuciDHCPLeases = rpc.declare({ object: 'luci-rpc', method: 'getDHCPLeases', expect: { '': {} } });
var callDialStatus = rpc.declare({ object: 'qmodem', method: 'dial_status', params: ['config_section'], expect: {} });

function truthy(v) {
	return v === true || v === 1 || v === '1' || v === 'true';
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

return view.extend({
	title: '網路拓撲',

	load: function() {
		return uci.load('qmodem').then(function() {
			var cur = null;
			uci.sections('qmodem', 'modem-device', function(s) {
				if (!cur && s.at_port) {
					var ifn = (s.alias && s.alias !== '-') ? s.alias : s['.name'];
					cur = { id: s['.name'], ifname: ifn, name: ifn.toUpperCase() };
				}
			});
			return cur;
		});
	},

	render: function(modem) {
		if (!modem)
			return E('div', { 'class': 'cbi-map' }, [
				E('h3', '網路拓撲'),
				E('div', { 'class': 'alert-message warning' }, '未找到已啟用的 qmodem 模組設定，請先安裝 qmodem 並完成設定。')
			]);

		var cur = modem, topoHost = null, refs = {};

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
			Promise.all([
				topoName(),
				callInterfaceDump().catch(function() { return []; }),
				L.resolveDefault(callLuciDHCPLeases(), {}),
				L.resolveDefault(network.getWifiNetworks(), []).catch(function() { return []; }),
				L.resolveDefault(network.getHostHints(), null),
				L.resolveDefault(callDialStatus(cur.id), {})
			]).then(function(r) {
				return Promise.all(r[3].map(function(net) {
					var f = parseFloat(net.getFrequency() || '0');
					return L.resolveDefault(net.getAssocList(), []).then(function(l) {
						return { band: f >= 5 ? '5g' : '24g', list: l };
					}).catch(function() { return { band: '24g', list: [] }; });
				})).then(function(assocs) {
					renderTopo(r[0], r[1], assocs, r[4], r[5]);
				});
			}).catch(function() { });
		}

		function renderTopo(d, leaseRes, assocs, hints, dial) {
			var list = Array.isArray(d) ? d : ((d && d.interface) || []),
				wan = null, lan = null;

			list.forEach(function(i) {
				if (!i)
					return;
				if (i.interface === cur.ifname || i.interface === cur.id)
					wan = i;
				else if (i.interface === 'lan')
					lan = i;
			});

			/* the uplink is the interface holding the default route */
			if (!wan)
				list.forEach(function(i) {
					if (wan)
						return;
					(i.route || []).forEach(function(r) {
						if (r && r.target === '0.0.0.0' && r.mask === 0)
							wan = i;
					});
				});

			function firstAddr(e, key) {
				var a = e && e[key];
				return (a && a.length && a[0].address) ? a[0].address : null;
			}

			/* merge v4 and v6 leases by MAC, preferring the v4 entry */
			var leaseByMac = {};
			((leaseRes && Array.isArray(leaseRes.dhcp6_leases)) ? leaseRes.dhcp6_leases : []).forEach(function(e) {
				if (e && e.macaddr)
					leaseByMac[e.macaddr.toLowerCase()] = { hostname: e.hostname, ip: e.ipaddr };
			});
			((leaseRes && Array.isArray(leaseRes.dhcp_leases)) ? leaseRes.dhcp_leases : []).forEach(function(e) {
				if (e && e.macaddr)
					leaseByMac[e.macaddr.toLowerCase()] = { hostname: e.hostname, ip: e.ipaddr };
			});

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
			Object.keys(leaseByMac).forEach(function(k) {
				var e = leaseByMac[k], st = null;
				if (stMac[k])
					stations.forEach(function(x) { if (x.mac.toLowerCase() === k) st = x; });
				if (st) {
					st.hostname = e.hostname;
					st.ip = e.ip;
					return;
				}
				wired.push({ mac: k, hostname: e.hostname, ip: e.ip });
			});
			stations.forEach(function(s) { groups[s.band].push(s); });

			/* vendor name chain: hostname, then the LuCI host hints, then IP/MAC */
			function devName(x) {
				return x.hostname || (hints ? hints.getHostnameByMACAddr(x.mac) : null) ||
					x.ip || x.mac || '(未命名)';
			}

			function devNode(p, n, x, conn) {
				return { id: p + n, name: devName(x), type: 'cpe', conn: conn,
					status: 'online', ip: x.ip, mac: x.mac };
			}

			/* the modem daemon's dial state is the authoritative uplink signal;
			   fall back to the netifd entry being up or carrying an address */
			var wanIp = firstAddr(wan, 'ipv4-address'),
				wanUp = truthy(dial && dial.running) ||
					!!(wan && (wan.up === true || (wan['ipv4-address'] || []).length));

			refs.topoDbg.textContent = 'WAN: ' + (wan ? wan.interface : '(未找到)') +
				' · up=' + (wan ? String(wan.up) : '-') +
				' · IPv4: ' + (wanIp || '-') +
				' · 撥號: ' + (truthy(dial && dial.running) ? '已撥號' : '未撥號') +
				' · dump 介面數: ' + list.length;

			var kids = [{ id: 'internet', name: 'Internet', type: 'internet',
					status: wanUp ? 'online' : 'offline',
					ip: wanIp }];

			if (wired.length)
				kids.push({ id: 'wired', name: '有線設備 (' + wired.length + ')', type: 'wired',
					status: 'online', children: wired.map(function(x, n) { return devNode('w', n, x, '有線'); }) });
			if (groups['24g'].length)
				kids.push({ id: 'wifi24', name: 'WiFi 2.4G (' + groups['24g'].length + ')', type: 'wireless',
					status: 'online', children: groups['24g'].map(function(x, n) { return devNode('a2', n, x, 'WiFi 2.4G'); }) });
			if (groups['5g'].length)
				kids.push({ id: 'wifi5', name: 'WiFi 5G (' + groups['5g'].length + ')', type: 'wireless',
					status: 'online', children: groups['5g'].map(function(x, n) { return devNode('a5', n, x, 'WiFi 5G'); }) });

			var root = { id: 'router', name: topoHost || '路由器', type: 'router',
					status: 'online', ip: firstAddr(lan, 'ipv4-address'), children: kids },
				/* netifd maintains rx_rate/tx_rate (bytes per second) per interface */
				rate = (wan && wan.statistics) ? ((Number(wan.statistics.rx_rate) || 0) + (Number(wan.statistics.tx_rate) || 0)) : 0,
				lay = topoLayout(root, rate / 1e6),
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
					tip = [nd.node.name || '', '類型: ' + (nd.node.conn || nd.node.type || ''),
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

		refs.topoSvg = E('div', { 'style': 'width:100%' });
		refs.topoTip = E('div', { 'style': 'position:absolute;z-index:30;display:none;pointer-events:none;white-space:nowrap;background:rgba(15,23,42,0.9);border:1px solid #334155;border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.6;color:#f1f5f9' });
		refs.topoDbg = E('div', { 'style': 'margin-top:6px;font-size:12px;color:#999' });
		refs.topoBox = E('div', { 'style': 'position:relative;width:100%' }, [refs.topoSvg, refs.topoTip]);

		poll.add(updateTopo, 10);
		updateTopo();

		return E('div', { 'class': 'cpe-wrap' }, [
			E('div', { 'class': 'cpe-section' }, [
				E('h3', '網路拓撲'),
				refs.topoBox,
				refs.topoDbg
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
