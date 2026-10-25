'use strict';
'require uci';
'require view';

var DEFAULT_URL = 'http://192.168.225.1';

return view.extend({
	title: '模組 WebUI',

	load: function() {
		return uci.load('cpe-dashboard').then(function() {
			return uci.get('cpe-dashboard', 'main', 'webui_url');
		}).catch(function() {
			return null;
		}).then(function(url) {
			return url || DEFAULT_URL;
		});
	},

	render: function(url) {
		var frame = E('iframe', {
			'src': url,
			'style': 'width:100%; height:calc(100vh - 240px); min-height:480px; border:1px solid rgba(128,128,128,0.3); border-radius:8px; background:#fff'
		});

		return E('div', { 'class': 'cpe-wrap' }, [
			E('div', { 'class': 'cpe-toolbar' }, [
				E('span', {}, '目標: '),
				E('a', { 'href': url, 'target': '_blank', 'rel': 'noreferrer', 'class': 'cbi-button cbi-button-link' }, url + '（新視窗開啟）'),
				E('button', { 'class': 'cbi-button', 'click': function(ev) { var f = this.parentNode.parentNode.querySelector('iframe'); if (f) f.src = f.src; } }, '重新載入')
			]),
			E('div', { 'class': 'alert-message notice' },
				'若下方頁面一片空白，代表模組 WebUI 拒絕被內嵌（X-Frame-Options / CSP），請改用上方連結以新視窗開啟。' +
				'網址可在 /etc/config/cpe-dashboard 的 webui_url 修改。'),
			frame
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
