'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require ui';
'require qmodem.qmodem as qmodem';
'require dom';
'require poll';

var callInitAction = rpc.declare({
	object: 'luci',
	method: 'setInitAction',
	params: ['name', 'action'],
	expect: { result: false }
});

/* toast shown above modals (ui.addNotification renders behind open modals) */
function apnNotify(msg, type) {
	var box = E('div', {
		'style': 'position:fixed; top:16px; left:50%; transform:translateX(-50%); z-index:99999;' +
			'padding:10px 18px; border-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,.4);' +
			'background:' + (type === 'error' ? '#c33' : '#2a7') + '; color:#fff; max-width:80%'
	}, msg);
	document.body.appendChild(box);
	setTimeout(function() {
		if (box.parentNode)
			box.parentNode.removeChild(box);
	}, 4000);
}

/* uci.commit() was replaced by uci.save()+apply() in newer LuCI */
function uciCommit(conf) {
	if (typeof uci.commit === 'function')
		return Promise.resolve(uci.commit(conf));
	return uci.save().then(function() { return uci.apply(10); });
}

/* 快速 APN 設定浮動視窗：僅 APN／帳號／密碼／驗證方式 四個欄位。
   寫入 uci qmodem modem-device 段；與 modem_dial.sh 一致，SIM slot 2
   使用 apn2/username2/password2/auth2（未設定時退回 slot 1）。
   commit 後 luci apply 觸發 qmodem_network reload 自動重新撥號。 */
function openApnQuickModal(view, section_id) {
	var isSlot2 = String(uci.get('qmodem', section_id, 'sim_slot') || '') === '2';
	var kApn = isSlot2 ? 'apn2' : 'apn';
	var kAuth = isSlot2 ? 'auth2' : 'auth';
	var kUser = isSlot2 ? 'username2' : 'username';
	var kPass = isSlot2 ? 'password2' : 'password';

	/* slot2 讀值退回 slot1（同撥號腳本行為） */
	function cfg(name, fallback) {
		var v = uci.get('qmodem', section_id, name);
		if ((v == null || v === '') && fallback)
			v = uci.get('qmodem', section_id, fallback);
		return v == null ? '' : String(v);
	}

	var auth = cfg(kAuth, isSlot2 ? 'auth' : null);
	if (['none', 'pap', 'chap', 'MsChapV2'].indexOf(auth) < 0)
		auth = 'none';

	var inpStyle = 'width:100%;box-sizing:border-box';
	var inpApn = E('input', {
		'type': 'text',
		'style': inpStyle,
		'placeholder': '留空 = 自動選擇',
		'value': cfg(kApn, isSlot2 ? 'apn' : null)
	});
	var selAuth = E('select', { 'style': inpStyle }, [
		E('option', { 'value': 'none' }, '不驗證'),
		E('option', { 'value': 'pap' }, 'PAP'),
		E('option', { 'value': 'chap' }, 'CHAP'),
		E('option', { 'value': 'MsChapV2' }, 'MsChapV2')
	]);
	selAuth.value = auth;
	var inpUser = E('input', { 'type': 'text', 'style': inpStyle, 'value': cfg(kUser, isSlot2 ? 'username' : null) });
	var inpPass = E('input', { 'type': 'password', 'style': inpStyle, 'value': cfg(kPass, isSlot2 ? 'password' : null) });

	/* 已存 APN 設定檔當建議清單 */
	var dl = E('datalist', { 'id': 'apn-quick-profiles' });
	uci.sections('cpe-dashboard', 'apn_profile').forEach(function(p) {
		if (p.apn)
			dl.appendChild(E('option', { 'value': p.apn }, p.name || ''));
	});
	inpApn.setAttribute('list', 'apn-quick-profiles');

	function row(label, input) {
		return E('div', { 'style': 'margin:10px 0' }, [
			E('label', { 'style': 'display:block;font-weight:600;margin-bottom:3px' }, label),
			input
		]);
	}
	var userRow = row('帳號', inpUser);
	var passRow = row('密碼', inpPass);
	function toggleAuth() {
		var hide = selAuth.value === 'none';
		userRow.style.display = hide ? 'none' : '';
		passRow.style.display = hide ? 'none' : '';
	}
	selAuth.addEventListener('change', toggleAuth);

	var btnApply = E('button', { 'class': 'btn cbi-button-positive', 'style': 'margin-left:6px' }, '儲存並重新撥號');
	var btnCancel = E('button', { 'class': 'btn cbi-button-negative' }, '取消');
	btnCancel.addEventListener('click', function() { ui.hideModal(); });
	inpApn.addEventListener('keydown', function(ev) {
		if (ev.key === 'Enter')
			btnApply.click();
	});

	btnApply.addEventListener('click', function() {
		var apn = String(inpApn.value).trim();
		var a = selAuth.value;
		var user = String(inpUser.value).trim();
		var pass = inpPass.value;

		btnApply.classList.add('disabled');
		if (apn)
			uci.set('qmodem', section_id, kApn, apn);
		else
			uci.unset('qmodem', section_id, kApn);
		uci.set('qmodem', section_id, kAuth, a);
		if (a !== 'none' && user)
			uci.set('qmodem', section_id, kUser, user);
		else
			uci.unset('qmodem', section_id, kUser);
		if (a !== 'none' && pass)
			uci.set('qmodem', section_id, kPass, pass);
		else
			uci.unset('qmodem', section_id, kPass);

		return uciCommit('qmodem').then(function() {
			ui.hideModal();
			apnNotify('APN 設定已儲存，正在重新撥號（約需數十秒）', 'ok');
			if (view && view.updateApnDisplay)
				view.updateApnDisplay(section_id);
		}).catch(function(err) {
			btnApply.classList.remove('disabled');
			apnNotify('儲存失敗: ' + (err && err.message ? err.message : err), 'error');
		});
	});

	var modemName = uci.get('qmodem', section_id, 'alias') || uci.get('qmodem', section_id, 'name') || section_id;
	ui.showModal('快速設定 APN — ' + modemName + (isSlot2 ? '（SIM 2）' : ''), E('div', {}, [
		E('div', {}, [
			E('div', { 'style': 'color:#888;font-size:12px' }, '僅顯示常用項目；完整選項請點擊該列進行編輯。'),
			row('APN', inpApn),
			dl,
			row('驗證方式', selAuth),
			userRow,
			passRow
		]),
		E('div', { 'class': 'right', 'style': 'margin-top:12px' }, [btnCancel, btnApply])
	]));
	toggleAuth();
	inpApn.focus();
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('qmodem'),
			uci.load('cpe-dashboard').catch(function() {}),
			qmodem.rcStatus('qmodem_network')
		]).then(L.bind(function(results) {
			this.rcStatusData = results[2];
			
			// Load connection status for all modem devices
			var sections = uci.sections('qmodem', 'modem-device');
			var statusPromises = sections.map(function(section) {
				return qmodem.getConnectStatus(section['.name'])
					.then(function(status) {
						return { section_id: section['.name'], status: status };
					})
					.catch(function(err) {
						return { section_id: section['.name'], status: null };
					});
			});
			
			return Promise.all(statusPromises).then(L.bind(function(statuses) {
				this.connectionStatusData = {};
				statuses.forEach(L.bind(function(item) {
					this.connectionStatusData[item.section_id] = item.status;
				}, this));
				return results;
			}, this));
		}, this));
	},

	render: function() {
		var m, s, o;

		m = new form.Map('qmodem', _('QModem Configuration'));

		// Global Dial Configuration
		s = m.section(form.NamedSection, 'main', 'main', _('Global Configuration'));

		o = s.option(form.Flag, 'enable_dial', _('Enable Dial (Global)'));
		o.default = '1';
		o.rmempty = false;

		// QModem network RC status and control
		var rcStatus = s.option(form.DummyValue, '_rc_status', _('QModem Network'));
		rcStatus.rawhtml = true;
		rcStatus.cfgvalue = L.bind(function() {
			var status = this.rcStatusData && this.rcStatusData.qmodem_network ? this.rcStatusData.qmodem_network : null;
			
			if (!status) {
				return E('div', { id: 'rc-status-container' }, [
					E('span', {}, _('Failed to load status'))
				]);
			}
			
			var enabled = status.enabled === true || status.enabled === 'true';
			var running = status.running === true || status.running === 'true';
			
			return E('div', { id: 'rc-status-container' }, [
				E('span', {}, _('Enabled') + ': ' + (enabled ? _('Yes') : _('No'))),
				E('span', { 'style': 'margin-left: 12px;' }, _('Running') + ': ' + (running ? _('Yes') : _('No')))
			]);
		}, this);

		var rcControl = s.option(form.DummyValue, '_rc_control', _('Control'));
		rcControl.rawhtml = true;
		rcControl.cfgvalue = L.bind(function() {
			var status = this.rcStatusData && this.rcStatusData.qmodem_network ? this.rcStatusData.qmodem_network : null;
			var enabled = status ? (status.enabled === true || status.enabled === 'true') : false;
			var running = status ? (status.running === true || status.running === 'true') : false;
			
			var buttons = [];
			
			// Running control: show Start if not running, show Stop and Restart if running
			if (!running) {
				buttons.push(
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'id': 'rc-start-button',
						'click': ui.createHandlerFn(this, function() {
							var self = this;
							return callInitAction('qmodem_network', 'start')
								.then(function() {
									ui.addNotification(null, E('p', _('QModem Network started successfully')));
									return self.updateRcStatus();
								})
								.catch(function(err) {
									ui.addNotification(null, E('p', _('Failed to start QModem Network: ') + err.message), 'error');
									return self.updateRcStatus();
								});
						})
					}, _('Start'))
				);
			} else {
				buttons.push(
					E('button', {
						'class': 'cbi-button cbi-button-reset',
						'id': 'rc-stop-button',
						'click': ui.createHandlerFn(this, function() {
							var self = this;
							return callInitAction('qmodem_network', 'stop')
								.then(function() {
									ui.addNotification(null, E('p', _('QModem Network stopped successfully')));
									return self.updateRcStatus();
								})
								.catch(function(err) {
									ui.addNotification(null, E('p', _('Failed to stop QModem Network: ') + err.message), 'error');
									return self.updateRcStatus();
								});
						})
					}, _('Stop'))
				);
				buttons.push(
					E('button', {
						'class': 'cbi-button cbi-button-apply',
						'id': 'rc-restart-button',
						'click': ui.createHandlerFn(this, function() {
							var self = this;
							return callInitAction('qmodem_network', 'restart')
								.then(function() {
									ui.addNotification(null, E('p', _('QModem Network restarted successfully')));
									return self.updateRcStatus();
								})
								.catch(function(err) {
									ui.addNotification(null, E('p', _('Failed to restart QModem Network: ') + err.message), 'error');
									return self.updateRcStatus();
								});
						})
					}, _('Restart'))
				);
			}
			
			buttons.push(E('span', { 'style': 'margin: 0 8px;' }, ' | '));

			// Enabled control: show Enable if not enabled, show Disable if enabled
			if (!enabled) {
				buttons.push(
					E('button', {
						'class': 'cbi-button cbi-button-apply',
						'id': 'rc-enable-button',
						'click': ui.createHandlerFn(this, function() {
							var self = this;
							return callInitAction('qmodem_network', 'enable')
								.then(function() {
									ui.addNotification(null, E('p', _('QModem Network enabled successfully')));
									return self.updateRcStatus();
								})
								.catch(function(err) {
									ui.addNotification(null, E('p', _('Failed to enable QModem Network: ') + err.message), 'error');
									return self.updateRcStatus();
								});
						})
					}, _('Enable'))
				);
			} else {
				buttons.push(
					E('button', {
						'class': 'cbi-button cbi-button-negative',
						'id': 'rc-disable-button',
						'click': ui.createHandlerFn(this, function() {
							var self = this;
							return callInitAction('qmodem_network', 'disable')
								.then(function() {
									ui.addNotification(null, E('p', _('QModem Network disabled successfully')));
									return self.updateRcStatus();
								})
								.catch(function(err) {
									ui.addNotification(null, E('p', _('Failed to disable QModem Network: ') + err.message), 'error');
									return self.updateRcStatus();
								});
						})
					}, _('Disable'))
				);
			}
			
			return E('div', { id: 'rc-control-container' }, buttons);
		}, this);

	// Dial Configuration Section (Per-Modem)
	s = m.section(form.GridSection, 'modem-device', _('Dial Configuration'));
	s.anonymous = false;
	s.addremove = false;
	s.modaltitle = L.bind(function(section_id) {
		var name = uci.get('qmodem', section_id, 'name');
		var alias = uci.get('qmodem', section_id, 'alias');
		return _('Dial Configuration') + ': ' + (alias || name || section_id);
	}, this);

	// Connection Status Indicator
	o = s.option(form.DummyValue, '_status_indicator', _('Status'));
	o.rawhtml = true;
	o.editable = true;
	o.width = '60px';
	o.cfgvalue = L.bind(function(section_id) {
		var color = '#999'; // Gray (default/loading)
		var title = _('Loading...');
		
		// Use preloaded data if available
		if (this.connectionStatusData && this.connectionStatusData[section_id]) {
			var result = this.connectionStatusData[section_id];
			if (result && result.connection_status !== undefined) {
				var status = result.connection_status.toString().toLowerCase();
				if (status === 'yes' || status === 'connected' || status === '1' || status === 'true' || status === true) {
					color = '#00FF00'; // Green (connected)
					title = _('Connected');
				} else if (status === 'no' || status === 'disconnected' || status === '0' || status === 'false' || status === false) {
					color = '#FF0000'; // Red (disconnected)
					title = _('Disconnected');
				} else {
					color = '#FFA500'; // Yellow (unknown)
					title = _('Unknown');
				}
			}
		}
		
		return E('div', {
			'id': 'status-indicator-' + section_id,
			'style': 'text-align: center;'
		}, [
			E('span', {
				'style': 'display: inline-block; width: 12px; height: 12px; border-radius: 50%; background-color: ' + color + ';',
				'title': title
			})
		]);
	}, this);

	o = s.option(form.Flag, 'enable_dial', _('Enable Dial'));
		o.default = '0';
		o.rmempty = false;
		o.editable = true;

		o = s.option(form.DummyValue, 'name', _('Modem Model'));
		o.cfgvalue = function(section_id) {
			var name = uci.get('qmodem', section_id, 'name') || '';
			return name.toUpperCase();
		};

		o = s.option(form.DummyValue, 'alias', _('Modem Alias'));
		o.cfgvalue = function(section_id) {
			return uci.get('qmodem', section_id, 'alias') || '-';
		};

	o = s.option(form.DummyValue, 'state', _('Status'));
	o.cfgvalue = function(section_id) {
		var state = uci.get('qmodem', section_id, 'state');
		return state ? _(state.toUpperCase()) : _('Unknown');
	};

	// Dial Log View Button
	o = s.option(form.DummyValue, '_dial_log', _('Dial Log'));
	o.rawhtml = true;
	o.modalonly = false;
	o.editable = true;
	o.cfgvalue = L.bind(function(section_id) {
		var enable_dial = uci.get('qmodem', section_id, 'enable_dial');
		if (enable_dial === '0') {
			return E('span', {}, '-');
		}
		
		return E('button', {
			'class': 'cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, function(section_id) {
				this.showDialLogDialog(section_id);
			}, section_id)
		}, _('View Log'));
	}, this);

	// Dial Control Buttons
	o = s.option(form.DummyValue, '_dial_controls', _('Dial Control'));
		o.rawhtml = true;
		o.modalonly = false;
		o.editable = true;
		o.cfgvalue = function(section_id) {
			var enable_dial = uci.get('qmodem', section_id, 'enable_dial');
			if (enable_dial === '0') {
				return E('div', {}, _('Dial disabled for this modem'));
			}
			
			return E('div', { 
				'class': 'cbi-value-field', 
				'id': 'dial-controls-' + section_id,
				'data-section': section_id
			}, [
				E('span', {}, _('Loading...'))
			]);
		};

	// Currently used APN (live, from modem network info)
	o = s.option(form.DummyValue, '_cur_apn', '目前 APN');
	o.rawhtml = true;
	o.editable = true;
	o.cfgvalue = L.bind(function(section_id) {
		var cfg = uci.get('qmodem', section_id, 'apn') || '';
		var self = this;
		var btn = E('button', {
			'class': 'btn cbi-button-positive apn-quick-btn',
			'style': 'display:block;margin-top:5px;padding:2px 10px;font-size:12px',
			'title': '快速設定 APN／帳號／密碼／驗證方式'
		}, '快速設定');
		btn.addEventListener('click', function(ev) {
			ev.preventDefault();
			ev.stopPropagation();
			openApnQuickModal(self, section_id);
		});
		return E('div', {}, [
			E('span', { 'class': 'cur-apn', 'data-section': section_id, 'style': 'word-break:break-all' }, cfg || '自動選擇'),
			btn
		]);
	}, this);

	// Roaming on/off switch (Quectel AT+QNWPREFCFG="roam_pref")
	o = s.option(form.DummyValue, '_roaming', '漫遊');
	o.rawhtml = true;
	o.editable = true;
	o.cfgvalue = L.bind(function(section_id) {
		var self = this;
		var on = uci.get('qmodem', section_id, 'roaming') !== '0';
		var btn = E('button', {
			'class': 'btn roaming-btn ' + (on ? 'cbi-button-positive' : 'cbi-button-negative'),
			'style': 'white-space:nowrap',
			'data-section': section_id,
			'title': on ? '允許漫遊：自動註冊含漫遊（roam_pref=255）' : '關閉漫遊：僅註冊家網（roam_pref=1）'
		}, on ? '開啟' : '關閉');
		btn.addEventListener('click', function() {
			self.toggleRoaming(section_id, btn);
		});
		return btn;
	}, this);

	// ============ Modal Configuration Options ============
	
	// General Settings
	o = s.option(form.Value, 'alias', _('Modem Alias'));
	o.rmempty = true;
	o.modalonly = true;

	o = s.option(form.DynamicList, 'dns_list', _('DNS'));
	o.placeholder = _('If the DNS server is not set, it will use the DNS server leased by the operator.');
	o.rmempty = true;
	o.modalonly = true;

	o = s.option(form.Flag, 'use_ubus', _('Use Ubus'));
	o.default = '1';
	o.rmempty = false;
	o.modalonly = true;

	// Advanced Settings
	o = s.option(form.Flag, 'force_set_apn', _('Force Set APN'));
	o.description = _('If enabled, the APN will be set even if it matches the current configuration.(only works with tom modified version of quectel-cm)');
	o.default = '0';
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Flag, 'en_bridge', _('Bridge Mode'));
	o.description = _('Caution: Only avalible for quectel sdx 5G Modem.');
	o.default = '0';
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Value, 'bridge_port', _('Bridge Port'));
	o.description = _('Device-level bridge port for passthrough. If set, it overrides the slot default bridge port.');
	o.rmempty = true;
	o.modalonly = true;
	if (this.networkInterfaces && this.networkInterfaces.length > 0) {
		this.networkInterfaces.forEach(function(iface) {
			o.value(iface.id, iface.label);
		});
	}

	o = s.option(form.Flag, 'do_not_add_dns', _('Do Not modify resolv.conf'));
	o.description = _('quectel-CM will append the DNS server to the resolv.conf file by default.if you do not want to modify the resolv.conf file, please check this option.');
	o.default = '0';
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Flag, 'donot_nat', _('Do Not NAT(Only for Quectel Modem)'));
	o.description = _('If enabled, will turn off NAT function on quectel modem.');
	o.default = '0';
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Flag, 'ra_master', _('RA Master'));
	o.description = _('Caution: Enabling this option will make it the IPV6 RA Master, and only one interface can be configured as such.');
	o.default = '0';
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Flag, 'extend_prefix', _('Extend Prefix'));
	o.description = _('Once checking, the prefix will be apply to lan zone');
	o.default = '0';
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Value, 'pdp_index', _('PDP Context Index'));
	o.rmempty = true;
	o.modalonly = true;

	o = s.option(form.ListValue, 'pdp_type', _('PDP Type'));
	o.value('ip', _('IPv4'));
	o.value('ipv6', _('IPv6'));
	o.value('ipv4v6', _('IPv4/IPv6'));
	o.value('ethernet', _('Ethernet'));
	o.default = 'ipv4v6';
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Value, 'apn', _('APN'));
	o.placeholder = _('Auto Choose');
	o.rmempty = true;
	o.modalonly = true;
	o.value('', _('Auto Choose'));
	o.value('internet', 'internet');
	uci.sections('cpe-dashboard', 'apn_profile').forEach(function(p) {
		if (p.apn)
			o.value(p.apn, (p.name || p.apn) + ' (' + p.apn + ')');
	});

	// APN profile manager: profiles are stored in /etc/config/cpe-dashboard
	o = s.option(form.DummyValue, '_apn_mgr', 'APN 設定檔');
	o.rawhtml = true;
	o.modalonly = true;
	o.cfgvalue = L.bind(function(section_id) {
		var sel, nameI;

		function fillSel() {
			while (sel.firstChild)
				sel.removeChild(sel.firstChild);
			sel.appendChild(E('option', { 'value': '' }, '— 選擇設定檔 —'));
			uci.sections('cpe-dashboard', 'apn_profile').forEach(function(p) {
				if (p.apn || p.name)
					sel.appendChild(E('option', { 'value': p['.name'] }, (p.name || p.apn) + (p.apn ? ' (' + p.apn + ')' : '')));
			});
		}

		function field(name) {
			return document.getElementById('cbid.qmodem.' + section_id + '.' + name);
		}

		function getVal(name) {
			var el = field(name);
			return el ? String(el.value).trim() : '';
		}

		function setVal(name, val) {
			var el = field(name);
			if (!el)
				return;
			/* ListValue/Combobox fields render as div.cbi-dropdown widgets:
			   the value must be selected via a select event on the option li */
			if (el.classList && el.classList.contains('cbi-dropdown')) {
				var li = val === ''
					? el.querySelector('ul > li[placeholder]')
					: el.querySelector('ul > li[data-value="' + val + '"]');
				if (li)
					li.dispatchEvent(new CustomEvent('cbi-dropdown-select', { 'bubbles': true }));
				else if (val !== '')
					apnNotify('值「' + val + '」不在「' + name + '」選項中，重新開啟編輯視窗後可選', 'error');
				return;
			}
			el.value = val;
			el.dispatchEvent(new Event('change', { 'bubbles': true }));
		}

		function currentProfile(name) {
			return {
				name: name,
				apn: getVal('apn'),
				protocol: getVal('pdp_type'),
				auth: getVal('auth'),
				username: getVal('username'),
				password: getVal('password')
			};
		}

		function saveProfile(id, p, msg) {
			if (!uci.get('cpe-dashboard', id))
				uci.add('cpe-dashboard', 'apn_profile', id);
			uci.set('cpe-dashboard', id, 'name', p.name);
			uci.set('cpe-dashboard', id, 'apn', p.apn);
			uci.set('cpe-dashboard', id, 'protocol', p.protocol || 'ipv4v6');
			uci.set('cpe-dashboard', id, 'auth', p.auth || 'none');
			if (p.username)
				uci.set('cpe-dashboard', id, 'username', p.username);
			else
				uci.unset('cpe-dashboard', id, 'username');
			if (p.password)
				uci.set('cpe-dashboard', id, 'password', p.password);
			else
				uci.unset('cpe-dashboard', id, 'password');
			uciCommit('cpe-dashboard').then(function() {
				fillSel();
				nameI.value = '';
				apnNotify(msg + '「' + (p.name || p.apn) + '」');
			}).catch(function(e) {
				apnNotify('儲存失敗：' + e.message, 'error');
			});
		}

		sel = E('select', { 'class': 'cbi-input-select' });
		nameI = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': '設定檔名稱（留空＝用 APN）' });

		var loadBtn = E('button', { 'class': 'btn cbi-button-action', 'click': function() {
			if (!sel.value) {
				apnNotify('請先選擇設定檔', 'error');
				return;
			}
			var p = uci.get('cpe-dashboard', sel.value) || {};
			setVal('apn', p.apn || '');
			if (p.protocol)
				setVal('pdp_type', p.protocol);
			setVal('auth', p.auth || 'none');
			setVal('username', p.username || '');
			setVal('password', p.password || '');
		} }, '載入');

		var addBtn = E('button', { 'class': 'btn cbi-button-add', 'click': function() {
			var apn = getVal('apn');
			if (!apn) {
				apnNotify('請先在上方的 APN 欄位輸入或選擇 APN，再按「新增」', 'error');
				return;
			}
			var id = 'apn' + Math.random().toString(36).slice(2, 10);
			saveProfile(id, currentProfile(nameI.value.trim() || apn), '已新增設定檔');
		} }, '新增');

		var updBtn = E('button', { 'class': 'btn cbi-button-change', 'click': function() {
			if (!sel.value) {
				apnNotify('請先選擇要更新的設定檔', 'error');
				return;
			}
			var old = uci.get('cpe-dashboard', sel.value) || {};
			saveProfile(sel.value, currentProfile(nameI.value.trim() || old.name || getVal('apn')), '已更新設定檔');
		} }, '更新');

		var delBtn = E('button', { 'class': 'btn cbi-button-negative', 'click': function() {
			if (!sel.value) {
				apnNotify('請先選擇要刪除的設定檔', 'error');
				return;
			}
			uci.remove('cpe-dashboard', sel.value);
			uciCommit('cpe-dashboard').then(function() {
				fillSel();
			});
		} }, '刪除');

		fillSel();

		return E('div', { 'style': 'display:flex; gap:6px; flex-wrap:wrap; align-items:center' },
			[sel, nameI, loadBtn, addBtn, updBtn, delBtn]);
	}, this);

	o = s.option(form.ListValue, 'auth', _('Authentication Type'));
	o.value('none', _('NONE'));
	o.value('MsChapV2', _('MsChapV2'));
	o.value('pap', 'PAP');
	o.value('chap', 'CHAP');
	o.default = 'none';
	o.rmempty = false;
	o.modalonly = true;

	o = s.option(form.Value, 'username', _('PAP/CHAP Username'));
	o.rmempty = true;
	o.modalonly = true;
	o.depends('auth', 'both');
	o.depends('auth', 'pap');
	o.depends('auth', 'chap');
	o.depends('auth', 'MsChapV2');

	o = s.option(form.Value, 'password', _('PAP/CHAP Password'));
	o.password = true;
	o.rmempty = true;
	o.modalonly = true;
	o.depends('auth', 'both');
	o.depends('auth', 'pap');
	o.depends('auth', 'chap');
	o.depends('auth', 'MsChapV2');

	o = s.option(form.Value, 'pincode', _('PIN Code'));
	o.description = _('If the PIN code is not set, leave it blank.');
	o.rmempty = true;
	o.modalonly = true;

	// Slot 2 Configuration
	o = s.option(form.Value, 'apn2', _('APN') + ' 2');
	o.description = _('If slot 2 config is not set,will use slot 1 config.');
	o.placeholder = _('Auto Choose');
	o.rmempty = true;
	o.modalonly = true;
	o.value('', _('Auto Choose'));
	o.value('internet', 'internet');
	uci.sections('cpe-dashboard', 'apn_profile').forEach(function(p) {
		if (p.apn)
			o.value(p.apn, (p.name || p.apn) + ' (' + p.apn + ')');
	});

	o = s.option(form.Value, 'metric', _('Metric'));
	o.description = _('The metric value is used to determine the priority of the route. The smaller the value, the higher the priority. Cannot duplicate.');
	o.default = '10';
	o.rmempty = true;
	o.modalonly = true;

	// Pre Dial Delay
	o = s.option(form.Value, 'pre_dial_delay', _('Pre Dial Delay') + ' ' + _('(beta)'));
	o.description = _('Delay of executing AT command before dialing, in seconds.') + _('(still in beta)');
	o.placeholder = _('Enter delay in seconds');
	o.default = '0';
	o.datatype = 'uinteger';
	o.rmempty = true;
	o.modalonly = true;

	// Post Init Delay
	o = s.option(form.Value, 'post_init_delay', _('Post Init Delay') + ' ' + _('(beta)'));
	o.description = _('Delay of executing AT command after modem initialization, in seconds.') + _('(still in beta)');
	o.placeholder = _('Enter delay in seconds');
	o.default = '0';
	o.datatype = 'uinteger';
	o.rmempty = true;
	o.modalonly = true;

	// Post Init AT Commands
	o = s.option(form.DynamicList, 'post_init_at_cmds', _('Post Init AT Commands') + ' ' + _('(beta)'));
	o.description = _('AT commands to execute after modem initialization.') + _('(still in beta)');
	o.placeholder = _('Enter AT commands');
	o.rmempty = true;
	o.modalonly = true;

	// Pre Dial AT Commands
	o = s.option(form.DynamicList, 'pre_dial_at_cmds', _('Pre Dial AT Commands') + ' ' + _('(beta)'));
	o.description = _('AT commands to execute before dialing.') + _('(still in beta)');
	o.placeholder = _('Enter AT commands');
	o.rmempty = true;
	o.modalonly = true;

	return m.render().then(L.bind(function(rendered) {
			// Update dial controls for all modems
			this.updateAllDialControls();
			// Update connection status indicators
			this.updateAllStatusIndicators();
			// Start polling for dial status
			this.startDialStatusPolling();
			// Start polling for connection status
			this.startStatusIndicatorPolling();
			// Start polling for RC status
			this.startRcStatusPolling();
			// Show and poll currently used APN
			this.updateAllApnDisplays();
			this.startApnPolling();
			// Sync roaming buttons with modem state once
			this.updateRoamingDisplays();
			return rendered;
		}, this));
	},

	updateDialControls: function(section_id, isRunning) {
		var container = document.getElementById('dial-controls-' + section_id);
		if (!container) return;

		// Clear existing content
		while (container.firstChild) {
			container.removeChild(container.firstChild);
		}

		var buttons = [];
		
		if (isRunning) {
			// Show Hang and ReDial buttons when service is running
			buttons.push(
				E('button', {
					'class': 'cbi-button cbi-button-reset',
					'click': ui.createHandlerFn(this, function(section_id) {
						return qmodem.modemHang(section_id).then(L.bind(function(result) {
							if (result && result.result && result.result.status === '1') {
								ui.addNotification(null, E('p', _('Hang command sent successfully')));
								// Update status after hang
								setTimeout(L.bind(function() {
									this.updateDialControlsForSection(section_id);
								}, this), 1000);
							} else {
								ui.addNotification(null, E('p', _('Failed to send hang command')), 'error');
							}
						}, this)).catch(function(err) {
							ui.addNotification(null, E('p', _('Error: ') + err.message), 'error');
						});
					}, section_id)
				}, _('Hang')),
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, function(section_id) {
						return qmodem.modemRedial(section_id).then(function(result) {
							if (result && result.result && result.result.status === '1') {
								ui.addNotification(null, E('p', _('Redial command sent successfully')));
							} else {
								ui.addNotification(null, E('p', _('Failed to send redial command')), 'error');
							}
						}).catch(function(err) {
							ui.addNotification(null, E('p', _('Error: ') + err.message), 'error');
						});
					}, section_id)
				}, _('ReDial'))
			);
		} else {
			// Show Dial button when service is not running
			buttons.push(
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function(section_id) {
						return qmodem.modemDial(section_id).then(L.bind(function(result) {
							if (result && result.result && result.result.status === '1') {
								ui.addNotification(null, E('p', _('Dial command sent successfully')));
								// Update status after dial
								setTimeout(L.bind(function() {
									this.updateDialControlsForSection(section_id);
								}, this), 1000);
							} else {
								ui.addNotification(null, E('p', _('Failed to send dial command')), 'error');
							}
						}, this)).catch(function(err) {
							ui.addNotification(null, E('p', _('Error: ') + err.message), 'error');
						});
					}, section_id)
				}, _('Dial'))
			);
		}

		buttons.forEach(function(btn) {
			container.appendChild(btn);
		});
	},

	updateDialControlsForSection: function(section_id) {
		return qmodem.getDialStatus(section_id).then(L.bind(function(result) {
			if (result && result.running !== undefined) {
				var isRunning = (result.running === 'true' || result.running === true);
				this.updateDialControls(section_id, isRunning);
			}
		}, this)).catch(function(err) {
			console.error('Failed to get dial status for ' + section_id + ':', err);
		});
	},

	updateAllDialControls: function() {
		var sections = uci.sections('qmodem', 'modem-device');
		sections.forEach(L.bind(function(section) {
			var enable_dial = uci.get('qmodem', section['.name'], 'enable_dial');
			if (enable_dial !== '0') {
				this.updateDialControlsForSection(section['.name']);
			}
		}, this));
	},

	startDialStatusPolling: function() {
		poll.add(L.bind(function() {
			this.updateAllDialControls();
		}, this), 5);
	},

	updateStatusIndicator: function(section_id) {
		var container = document.getElementById('status-indicator-' + section_id);
		if (!container) return;

		return qmodem.getConnectStatus(section_id).then(L.bind(function(result) {
			// Update cached data
			if (!this.connectionStatusData) {
				this.connectionStatusData = {};
			}
			this.connectionStatusData[section_id] = result;
			
			var color = '#FFA500'; // Yellow (default for error/unknown)
			var title = _('Unknown');

			if (result && result.connection_status !== undefined) {
				var status = result.connection_status;
				status = status.toString().toLowerCase();
				if (status === 'yes' || status === 'connected' || status === '1' || status === 'true' || status === true) {
					color = '#00FF00'; // Green (connected)
					title = _('Connected');
				} else if (status === 'no' || status === 'disconnected' || status === '0' || status === 'false' || status === false) {
					color = '#FF0000'; // Red (disconnected)
					title = _('Disconnected');
				}
			}

			// Update the dot color
			while (container.firstChild) {
				container.removeChild(container.firstChild);
			}
			container.appendChild(
				E('span', {
					'style': 'display: inline-block; width: 12px; height: 12px; border-radius: 50%; background-color: ' + color + ';',
					'title': title
				})
			);
		}, this)).catch(function(err) {
			// On error, show yellow dot
			while (container.firstChild) {
				container.removeChild(container.firstChild);
			}
			container.appendChild(
				E('span', {
					'style': 'display: inline-block; width: 12px; height: 12px; border-radius: 50%; background-color: #FFA500;',
					'title': _('Error: ') + err.message
				})
			);
		});
	},

	updateAllStatusIndicators: function() {
		var sections = uci.sections('qmodem', 'modem-device');
		sections.forEach(L.bind(function(section) {
			this.updateStatusIndicator(section['.name']);
		}, this));
	},

	startStatusIndicatorPolling: function() {
		poll.add(L.bind(function() {
			this.updateAllStatusIndicators();
		}, this), 5);
	},

	startRcStatusPolling: function() {
		poll.add(L.bind(function() {
			this.updateRcStatus();
		}, this), 10);
	},

	updateAllApnDisplays: function() {
		uci.sections('qmodem', 'modem-device').forEach(L.bind(function(section) {
			this.updateApnDisplay(section['.name']);
		}, this));
	},

	updateApnDisplay: function(section_id) {
		var els = document.querySelectorAll('span.cur-apn[data-section="' + section_id + '"]');
		if (!els.length)
			return;
		var self = this;
		var setAll = function(text, title) {
			for (var i = 0; i < els.length; i++) {
				els[i].textContent = text;
				els[i].title = title;
			}
		};
		var done = false;
		var atPort = uci.get('qmodem', section_id, 'at_port') || '';
		// 1) AT+CGCONTRDP: active PDP context -> the APN actually used on the line
		qmodem.sendAt(section_id, atPort, 'AT+CGCONTRDP', '1').then(function(result) {
			var res = (result && result.at_cfg && result.at_cfg.res) ? String(result.at_cfg.res) : '';
			var lines = res.match(/\+CGCONTRDP:[^\r\n]*/gi) || [];
			var want = parseInt(uci.get('qmodem', section_id, 'pdp_index') || '1', 10);
			var first = null, pick = null;
			lines.forEach(function(line) {
				var m = /\+CGCONTRDP:\s*(\d+)\s*,(.*)/.exec(line);
				if (!m)
					return;
				var fields = String(m[2]).split(','), apn = null;
				for (var i = 0; i < fields.length && !apn; i++) {
					var f = String(fields[i]).trim().replace(/^"+|"+$/g, '');
					if (!f || /^\d+$/.test(f) || /^[0-9.]+( [0-9.]+)?$/.test(f) || /^(IP|IPV4|IPV6|IPV4V6|IPV6V4|ETHERNET|PPP)$/i.test(f))
						continue;
					apn = f;
				}
				if (!apn)
					return;
				if (first === null)
					first = apn;
				if (parseInt(m[1], 10) === want)
					pick = apn;
			});
			return pick || first;
		}).then(function(apn) {
			if (apn) {
				done = true;
				setAll(apn, 'AT+CGCONTRDP 查詢結果（模組撥號實際使用的 APN）');
				return;
			}
			// 2) AT+CGDCONT?: defined contexts (empty APN = carrier assigns automatically)
			return qmodem.sendAt(section_id, atPort, 'AT+CGDCONT?', '1').then(function(result) {
				var res = (result && result.at_cfg && result.at_cfg.res) ? String(result.at_cfg.res) : '';
				var lines = res.match(/\+CGDCONT:\s*\d+\s*,\s*"[^"]*"\s*,\s*"[^"]*"/g) || [];
				var want = parseInt(uci.get('qmodem', section_id, 'pdp_index') || '1', 10);
				var first = null, pick = null;
				lines.forEach(function(line) {
					var m = /\+CGDCONT:\s*(\d+)\s*,\s*"[^"]*"\s*,\s*"([^"]*)"/.exec(line);
					if (!m || !m[2])
						return;
					if (first === null)
						first = m[2];
					if (parseInt(m[1], 10) === want)
						pick = m[2];
				});
				return pick || first;
			});
		}).then(function(apn) {
			if (done)
				return;
			if (apn) {
				done = true;
				setAll(apn, 'AT+CGDCONT? 查詢結果（模組設定的 APN）');
				return;
			}
			self.updateApnDisplayFallback(section_id, setAll);
		}).catch(function() {
			if (!done)
				self.updateApnDisplayFallback(section_id, setAll);
		});
	},

	updateApnDisplayFallback: function(section_id, setAll) {
		qmodem.getNetworkInfo(section_id).then(L.bind(function(info) {
			var apn = null;
			var list = (info && Array.isArray(info.modem_info)) ? info.modem_info : [];
			list.forEach(function(e) {
				if (!e || !e.key || e.value == null || String(e.value) === '')
					return;
				var k = String(e.key).toUpperCase();
				if (k === 'APN')
					apn = String(e.value);
				else if (!apn && k.indexOf('APN') !== -1 && k.indexOf('APN2') === -1)
					apn = String(e.value);
			});
			if (!apn)
				apn = uci.get('qmodem', section_id, 'apn') || '';
			setAll(apn || '自動選擇', apn ? '模組即時資訊回報的 APN' : '模組未回報實際 APN（由電信商動態指派），顯示設定值');
		}, this)).catch(L.bind(function() {
			var cfg = uci.get('qmodem', section_id, 'apn') || '';
			setAll(cfg || '自動選擇', '無法取得模組即時資訊，顯示設定值');
		}, this));
	},

	startApnPolling: function() {
		poll.add(L.bind(function() {
			this.updateAllApnDisplays();
		}, this), 5);
	},

	toggleRoaming: function(section_id, btn) {
		var self = this;
		var on = uci.get('qmodem', section_id, 'roaming') !== '0';
		var want = !on;
		var atRes = function(r) {
			return (r && r.at_cfg && r.at_cfg.res) ? String(r.at_cfg.res) : '';
		};
		var setCfg = function(val) {
			uci.set('qmodem', section_id, 'roaming', val);
			return uciCommit('qmodem');
		};

		btn.classList.add('disabled');
		btn.textContent = '設定中…';

		/* Quectel roam_pref: 1 = home only, 2 = roaming only, 255 = any */
		var atPort = uci.get('qmodem', section_id, 'at_port') || '';
		var cmd = want ? 'AT+QNWPREFCFG="roam_pref",255' : 'AT+QNWPREFCFG="roam_pref",1';
		qmodem.sendAt(section_id, atPort, cmd, '1').then(function(r) {
			var res = atRes(r);
			if (res.indexOf('OK') === -1)
				throw new Error('模組回應：' + res.replace(/[\r\n]+/g, ' '));
			return setCfg(want ? '1' : '0');
		}).then(function() {
			self.paintRoamingBtn(btn, want);
			apnNotify(want ? '漫遊已開啟（roam_pref=255，自動註冊含漫遊）' : '漫遊已關閉（roam_pref=1，僅註冊家網）');
		}).catch(function(e) {
			self.paintRoamingBtn(btn, on);
			apnNotify('漫遊設定失敗：' + e.message, 'error');
		});
	},

	paintRoamingBtn: function(btn, on) {
		btn.classList.remove('cbi-button-positive', 'cbi-button-negative', 'disabled');
		btn.classList.add(on ? 'cbi-button-positive' : 'cbi-button-negative');
		btn.textContent = on ? '開啟' : '關閉';
		btn.title = on ? '允許漫遊：自動註冊含漫遊（roam_pref=255）' : '關閉漫遊：僅註冊家網（roam_pref=1）';
	},

	// sync roaming buttons with the actual modem state once per page load
	updateRoamingDisplays: function() {
		uci.sections('qmodem', 'modem-device').forEach(L.bind(function(section) {
			var sid = section['.name'];
			var btn = document.querySelector('button.roaming-btn[data-section="' + sid + '"]');
			if (!btn)
				return;
			qmodem.sendAt(sid, section.at_port || '', 'AT+QNWPREFCFG="roam_pref"', '1').then(L.bind(function(r) {
				var res = (r && r.at_cfg && r.at_cfg.res) ? String(r.at_cfg.res) : '';
				var m = /\+QNWPREFCFG:\s*roam_pref\s*,\s*(\d+)/i.exec(res);
				if (!m)
					return;
				var on = m[1] !== '1';
				uci.set('qmodem', sid, 'roaming', on ? '1' : '0');
				this.paintRoamingBtn(btn, on);
				if (m[1] === '2')
					btn.title = '模組目前為「僅限漫遊」（roam_pref=2）';
			}, this)).catch(function() {});
		}, this));
	},

	updateRcStatus: function() {
		var statusContainer = document.getElementById('rc-status-container');
		var controlContainer = document.getElementById('rc-control-container');

		if (!statusContainer || !controlContainer) {
			return Promise.resolve();
		}

		return qmodem.rcStatus('qmodem_network').then(L.bind(function(result) {
			this.rcStatusData = result;
			var status = result && result.qmodem_network ? result.qmodem_network : null;

			// Update status display
			while (statusContainer.firstChild) {
				statusContainer.removeChild(statusContainer.firstChild);
			}

			if (status) {
				var enabled = status.enabled === true || status.enabled === 'true';
				var running = status.running === true || status.running === 'true';

				statusContainer.appendChild(E('div', {}, [
					E('span', {}, _('Enabled') + ': ' + (enabled ? _('Yes') : _('No'))),
					E('span', { 'style': 'margin-left: 12px;' }, _('Running') + ': ' + (running ? _('Yes') : _('No')))
				]));

				// Update control buttons
				while (controlContainer.firstChild) {
					controlContainer.removeChild(controlContainer.firstChild);
				}

				var buttons = [];

				// Running control: show Start if not running, show Stop and Restart if running
				if (!running) {
					buttons.push(
						E('button', {
							'class': 'cbi-button cbi-button-action',
							'id': 'rc-start-button',
							'click': ui.createHandlerFn(this, function() {
								var self = this;
								return callInitAction('qmodem_network', 'start')
									.then(function() {
										ui.addNotification(null, E('p', _('QModem Network started successfully')));
										return self.updateRcStatus();
									})
									.catch(function(err) {
										ui.addNotification(null, E('p', _('Failed to start QModem Network: ') + err.message), 'error');
										return self.updateRcStatus();
									});
							})
						}, _('Start'))
					);
				} else {
					buttons.push(
						E('button', {
							'class': 'cbi-button cbi-button-reset',
							'id': 'rc-stop-button',
							'click': ui.createHandlerFn(this, function() {
								var self = this;
								return callInitAction('qmodem_network', 'stop')
									.then(function() {
										ui.addNotification(null, E('p', _('QModem Network stopped successfully')));
										return self.updateRcStatus();
									})
									.catch(function(err) {
										ui.addNotification(null, E('p', _('Failed to stop QModem Network: ') + err.message), 'error');
										return self.updateRcStatus();
									});
							})
						}, _('Stop'))
					);
					buttons.push(
						E('button', {
							'class': 'cbi-button cbi-button-apply',
							'id': 'rc-restart-button',
							'click': ui.createHandlerFn(this, function() {
								var self = this;
								return callInitAction('qmodem_network', 'restart')
									.then(function() {
										ui.addNotification(null, E('p', _('QModem Network restarted successfully')));
										return self.updateRcStatus();
									})
									.catch(function(err) {
										ui.addNotification(null, E('p', _('Failed to restart QModem Network: ') + err.message), 'error');
										return self.updateRcStatus();
									});
							})
						}, _('Restart'))
					);
				}

				buttons.push(E('span', { 'style': 'margin: 0 8px;' }, ' | '));

				// Enabled control: show Enable if not enabled, show Disable if enabled
				if (!enabled) {
					buttons.push(
						E('button', {
							'class': 'cbi-button cbi-button-apply',
							'id': 'rc-enable-button',
							'click': ui.createHandlerFn(this, function() {
								var self = this;
								return callInitAction('qmodem_network', 'enable')
									.then(function() {
										ui.addNotification(null, E('p', _('QModem Network enabled successfully')));
										return self.updateRcStatus();
									})
									.catch(function(err) {
										ui.addNotification(null, E('p', _('Failed to enable QModem Network: ') + err.message), 'error');
										return self.updateRcStatus();
									});
							})
						}, _('Enable'))
					);
				} else {
					buttons.push(
						E('button', {
							'class': 'cbi-button cbi-button-negative',
							'id': 'rc-disable-button',
							'click': ui.createHandlerFn(this, function() {
								var self = this;
								return callInitAction('qmodem_network', 'disable')
									.then(function() {
										ui.addNotification(null, E('p', _('QModem Network disabled successfully')));
										return self.updateRcStatus();
									})
									.catch(function(err) {
										ui.addNotification(null, E('p', _('Failed to disable QModem Network: ') + err.message), 'error');
										return self.updateRcStatus();
									});
							})
						}, _('Disable'))
					);
				}

				buttons.forEach(function(btn) {
					controlContainer.appendChild(btn);
				});
			} else {
				statusContainer.appendChild(E('span', {}, _('Failed to load status')));
			}
		}, this)).catch(L.bind(function(err) {
			while (statusContainer.firstChild) {
				statusContainer.removeChild(statusContainer.firstChild);
			}
			statusContainer.appendChild(E('span', {}, _('Error: ') + err.message));
		}, this));
	},

	showDialLogDialog: function(section_id) {
		var name = uci.get('qmodem', section_id, 'name');
		var alias = uci.get('qmodem', section_id, 'alias');
		var title = (alias || name || section_id) + ' - ' + _('Dial Log');
		
		var logContent = E('div', { 'style': 'min-height: 300px;' }, [
			E('div', { 'style': 'text-align: center; padding: 20px;' }, [
				E('span', { 'class': 'spinning' }, _('Loading...'))
			])
		]);

		var dialog = ui.showModal(title, [
			E('style', {}, '\
				.dial-log-content { \
					padding: 10px; \
					border-radius: 3px; \
					max-height: 400px; \
					width: 100%; \
					overflow-y: auto; \
					font-family: monospace; \
					font-size: 12px; \
					white-space: pre-wrap; \
					word-wrap: break-word; \
				} \
				.dial-log-empty { \
					text-align: center; \
					padding: 40px; \
				}'),
			logContent,
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': L.bind(function() {
						this.downloadDialLog(section_id);
					}, this)
				}, _('Download')),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-reset',
					'click': L.bind(function() {
						this.clearDialLogDialog(section_id, logContent);
					}, this)
				}, _('Clear')),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': ui.hideModal
				}, _('Close'))
			])
		], 'cbi-modal');

		// Load log content
		this.loadDialLog(section_id, logContent);
	},

	loadDialLog: function(section_id, container) {
		return qmodem.getDialLog(section_id).then(function(result) {
			while (container.firstChild) {
				container.removeChild(container.firstChild);
			}

			if (result && result.log) {
				if (result.log.trim() === '') {
					container.appendChild(
						E('div', { 'class': 'dial-log-empty' }, _('No log available'))
					);
				} else {
					container.appendChild(
							E('textarea', { 'class': 'dial-log-content','readonly':'readonly','rows':'20','maxlength':'160' }, result.log)
					);
				}
			} else {
				container.appendChild(
					E('div', { 'class': 'dial-log-empty' }, _('Failed to load log'))
				);
			}
		}).catch(function(err) {
			while (container.firstChild) {
				container.removeChild(container.firstChild);
			}
			container.appendChild(
				E('div', { 'class': 'dial-log-empty' }, _('Error: ') + err.message)
			);
		});
	},

	downloadDialLog: function(section_id) {
		return qmodem.getDialLog(section_id).then(function(result) {
			if (result && result.log) {
				var name = uci.get('qmodem', section_id, 'name') || section_id;
				var alias = uci.get('qmodem', section_id, 'alias') || '';
				var filename = 'dial_log_' + (alias || name) + '_' + 
					new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5) + '.txt';
				
				var blob = new Blob([result.log], { type: 'text/plain' });
				var url = window.URL.createObjectURL(blob);
				var a = document.createElement('a');
				a.href = url;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				window.URL.revokeObjectURL(url);
				document.body.removeChild(a);
				
				ui.addNotification(null, E('p', _('Log downloaded successfully')));
			} else {
				ui.addNotification(null, E('p', _('No log content to download')), 'warning');
			}
		}).catch(function(err) {
			ui.addNotification(null, E('p', _('Failed to download log: ') + err.message), 'error');
		});
	},

	clearDialLogDialog: function(section_id, container) {
		ui.showModal(_('Clear Dial Log'), [
			E('p', {}, _('Are you sure you want to clear the dial log?')),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': ui.hideModal
				}, _('Cancel')),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-negative',
					'click': L.bind(function() {
						qmodem.clearDialLog(section_id).then(L.bind(function(result) {
							if (result && result.result && result.result.status === '1') {
								ui.addNotification(null, E('p', _('Log cleared successfully')));
								ui.hideModal();
								// Reload the main dialog
								setTimeout(L.bind(function() {
									this.showDialLogDialog(section_id);
								}, this), 300);
							} else {
								ui.addNotification(null, E('p', _('Failed to clear log')), 'error');
								ui.hideModal();
							}
						}, this)).catch(function(err) {
							ui.addNotification(null, E('p', _('Error: ') + err.message), 'error');
							ui.hideModal();
						});
					}, this)
				}, _('Confirm'))
			])
		]);
	}
});
