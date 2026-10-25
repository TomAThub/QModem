'use strict';
'require view';
'require ui';
'require dom';
'require uci';
'require qmodem.qmodem as qmodem';

/* uci.commit() was replaced by uci.save()+apply() in newer LuCI */
function uciCommit(conf) {
	if (typeof uci.commit === 'function')
		return Promise.resolve(uci.commit(conf));
	return uci.save().then(function() { return uci.apply(10); });
}

return view.extend({
	load: function() {
		return Promise.all([
			qmodem.getModemSections(),
			uci.load('cpe-dashboard').catch(function() {})
		]).then(function(res) { return res[0]; });
	},

	render: function(modems) {
		if (!modems || modems.length === 0) {
			return E('div', { 'class': 'alert-message warning' }, 
				_('No modem configured.'));
		}

		var container = E('div', { 'class': 'cbi-map' });
		var title = E('h2', { 'class': 'cbi-map-caption' }, _('AT Debug'));
		container.appendChild(title);

		// Create modem selector section (similar to overview)
		var selectorSection = E('fieldset', { 'class': 'cbi-section' });
		var selectorTable = E('table', { 'class': 'table' });
		var selectorBody = E('tbody', {});
		var selectorRow = E('tr', { 'class': 'tr' });
		var labelCell = E('td', { 'class': 'td left', 'width': '33%' }, _('Modem Name'));
		var selectCell = E('td', { 'class': 'td' });
		
		// Create select dropdown
		var select = E('select', {
			'class': 'cbi-input-select',
			'id': 'modem_selector'
		});
		
		modems.forEach(function(modem) {
			if (modem.enabled) {
				select.appendChild(E('option', { 'value': modem.id }, modem.name));
			}
		});
		
		selectCell.appendChild(select);
		selectorRow.appendChild(labelCell);
		selectorRow.appendChild(selectCell);
		selectorBody.appendChild(selectorRow);
		selectorTable.appendChild(selectorBody);
		selectorSection.appendChild(selectorTable);
		container.appendChild(selectorSection);

		// Create AT interface container
		var interfaceContainer = E('div', { 'id': 'at_interface_container' });
		container.appendChild(interfaceContainer);

		var self = this;
		
		// Update function to show selected modem's interface
		var updateInterface = function() {
			var selectedId = select.value;
			var selectedModem = modems.find(function(m) { return m.id === selectedId; });
			
			if (selectedModem) {
				dom.content(interfaceContainer, self.createAtInterface(selectedModem, updateInterface));
			}
		};

		// Selector change handler
		select.addEventListener('change', updateInterface);

		// Initial display
		updateInterface();

		return container;
	},

	createAtInterface: function(modem, reload) {
		var self = this;
		var container = E('div', { 'class': 'cbi-section-node' });

		// AT Port Configuration
		var portSection = E('div', { 'class': 'cbi-value' });
		portSection.appendChild(E('label', { 'class': 'cbi-value-title' }, _('Available AT Ports')));
		var portInfo = E('div', { 'class': 'cbi-value-field' });
		portInfo.appendChild(E('div', { 'class': 'spinning' }, _('Loading...')));
		portSection.appendChild(portInfo);
		container.appendChild(portSection);

		// Load AT configuration
		qmodem.getAtCfg(modem.id).then(function(cfg) {
			if (!cfg || !cfg.at_cfg) {
				dom.content(portInfo, _('Failed to load AT configuration'));
				return;
			}

			var info = [];
			info.push(E('div', {}, [
				E('strong', {}, _('Current Port') + ': '),
				E('span', {}, cfg.at_cfg.using_port || 'N/A')
			]));

			if (cfg.at_cfg.ports && cfg.at_cfg.ports.length > 0) {
				info.push(E('div', {}, [
					E('strong', {}, _('Configured Ports') + ': '),
					E('span', {}, cfg.at_cfg.ports.join(', '))
				]));
			}

			if (cfg.at_cfg.other_ttys && cfg.at_cfg.other_ttys.length > 0) {
				info.push(E('div', {}, [
					E('strong', {}, _('Detected Ports') + ': '),
					E('span', {}, cfg.at_cfg.other_ttys.join(', '))
				]));
			}

			dom.content(portInfo, info);

			// Port selection dropdown
			var ports = [];
			if (cfg.at_cfg.ports) ports = ports.concat(cfg.at_cfg.ports);
			if (cfg.at_cfg.other_ttys) ports = ports.concat(cfg.at_cfg.other_ttys);

			var portSelectSection = E('div', { 'class': 'cbi-value' });
			portSelectSection.appendChild(E('label', { 'class': 'cbi-value-title' }, _('Select AT Port')));
			var portSelectField = E('div', { 'class': 'cbi-value-field' });
			
			var select = new ui.Dropdown(cfg.at_cfg.using_port || (ports.length > 0 ? ports[0] : ''),
				ports.reduce(function(obj, port) {
					obj[port] = port;
					return obj;
				}, {}), {
					id: 'at_port_' + modem.id,
					sort: false
				});
			
			portSelectField.appendChild(select.render());
			portSelectSection.appendChild(portSelectField);
			container.appendChild(portSelectSection);

			// Use Ubus flag option
			var ubusSection = E('div', { 'class': 'cbi-value' });
			ubusSection.appendChild(E('label', { 'class': 'cbi-value-title' }, _('Use Ubus AT Daemon')));
			var ubusField = E('div', { 'class': 'cbi-value-field' });
			
			var ubusCheckbox = E('input', {
				'type': 'checkbox',
				'id': 'use_ubus_' + modem.id,
				'checked': modem.use_ubus !== '0'
			});
			
			ubusField.appendChild(ubusCheckbox);
			ubusField.appendChild(document.createTextNode(' '));
			ubusField.appendChild(E('span', {}, _('Enable to use Ubus AT daemon instead of direct serial port access')));
			ubusSection.appendChild(ubusField);
			container.appendChild(ubusSection);

			// AT Command input
			var cmdSection = E('div', { 'class': 'cbi-value' });
			cmdSection.appendChild(E('label', { 'class': 'cbi-value-title' }, _('AT Command')));
			var cmdField = E('div', { 'class': 'cbi-value-field' });
			var cmdInput = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'id': 'at_command_' + modem.id,
				'placeholder': 'AT+CIMI'
			});
			cmdField.appendChild(cmdInput);
			cmdSection.appendChild(cmdField);
			container.appendChild(cmdSection);

			// Response area
			var responseSection = E('div', { 'class': 'cbi-value' });
			responseSection.appendChild(E('label', { 'class': 'cbi-value-title' }, _('Response')));
			var responseField = E('div', { 'class': 'cbi-value-field' });
			
			var responseDiv = E('textarea', {
				'id': 'at_response_' + modem.id,
				'style': 'padding: 10px; overflow-y: auto; font-family: monospace; white-space: pre-wrap; width: 80%;',
				'rows': 20,
				'readonly': 'readonly',
			}, _('Click "Send AT Command" to execute'));

			var sendBtn = E('button', {
				'class': 'btn cbi-button-action',
				'click': function() {
					var port = document.getElementById('at_port_' + modem.id).value;
					var cmd = document.getElementById('at_command_' + modem.id).value.trim();
					var useUbus = document.getElementById('use_ubus_' + modem.id).checked ? '1' : '0';

					if (!cmd) {
						responseDiv.textContent = _('Error: Please enter AT command');
						return;
					}

					responseDiv.textContent = _('Sending command...');

					// Use the use_ubus flag when sending AT command
					qmodem.sendAt(modem.id, port, cmd, useUbus).then(function(result) {
						if (result && result.at_cfg) {
							var text = '';
							text += 'Status: ' + (result.at_cfg.status === '1' ? 'Success' : 'Failed') + '\n';
							text += 'Command: ' + (result.at_cfg.cmd || '') + '\n';
							text += 'Response:\n' + (result.at_cfg.res || 'No response');
							responseDiv.textContent = text;
						} else {
							responseDiv.textContent = _('No response received');
						}
					}).catch(function(e) {
						responseDiv.textContent = _('Error: %s').format(e.message);
					});
				}
			}, _('Send AT Command'));

			responseField.appendChild(sendBtn);
			responseField.appendChild(E('br'));
			responseField.appendChild(E('br'));
			responseField.appendChild(responseDiv);
			responseSection.appendChild(responseField);
			container.appendChild(responseSection);

			// Quick commands: built-in (translated) + user defined
			var quickSection = E('div', { 'class': 'cbi-value' });
			quickSection.appendChild(E('label', { 'class': 'cbi-value-title' }, _('Quick Commands')));
			var quickField = E('div', { 'class': 'cbi-value-field cbi-section-actions' });

			// user defined commands first (newest added on top), then built-in
			uci.sections('cpe-dashboard', 'at_cmd').slice().reverse().forEach(function(s) {
				if (!s.value)
					return;
				quickField.appendChild(E('button', {
					'class': 'btn cbi-button-positive',
					'click': function() {
						document.getElementById('at_command_' + modem.id).value = s.value;
					}
				}, s.name || s.value));
				quickField.appendChild(document.createTextNode(' '));
			});

			if (cfg.at_cfg.cmds && cfg.at_cfg.cmds.length > 0) {
				cfg.at_cfg.cmds.forEach(function(cmd) {
					if (cmd.name && cmd.value) {
						quickField.appendChild(E('button', {
							'class': 'btn cbi-button-action',
							'click': function() {
								document.getElementById('at_command_' + modem.id).value = cmd.value;
							}
						}, _(cmd.name)));
						quickField.appendChild(document.createTextNode(' '));
					}
				});
			}

			quickSection.appendChild(quickField);
			container.appendChild(quickSection);

			container.appendChild(self.buildCustomManager(reload));
		}).catch(function(e) {
			dom.content(portInfo, _('Error loading AT configuration: %s').format(e.message));
		});

		return container;
	},

	buildCustomManager: function(reload) {
		var dels = [];
		var section = E('div', { 'class': 'cbi-value' });
		section.appendChild(E('label', { 'class': 'cbi-value-title' }, '自訂快速指令'));
		var field = E('div', { 'class': 'cbi-value-field', 'style': 'display:block; width:100%' });
		var list = E('div', { 'style': 'width:100%' });

		function addRow(id, name, value) {
			var nameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text',
				'style': 'flex:1 1 auto; min-width:0; box-sizing:border-box',
				'placeholder': '指令名稱', 'value': name || '' });
			var valInput = E('input', { 'type': 'text', 'class': 'cbi-input-text',
				'style': 'flex:1 1 auto; min-width:0; box-sizing:border-box',
				'placeholder': 'AT+...', 'value': value || '' });
			var delBtn = E('button', { 'class': 'btn cbi-button-negative',
				'style': 'flex:0 0 auto', 'click': function() {
				if (box.dataset.uciid)
					dels.push(box.dataset.uciid);
				box.parentNode.removeChild(box);
			} }, '刪除');
			var box = E('div', { 'class': 'at-cmd-row',
				'style': 'margin:6px 0; padding:8px; border:1px solid rgba(0,0,0,.25); border-radius:4px' }, [
				E('div', { 'style': 'display:flex; gap:6px; align-items:center' }, [
					E('span', { 'style': 'flex:0 0 42px' }, '名稱'), nameInput ]),
				E('div', { 'style': 'display:flex; gap:6px; align-items:center; margin-top:4px' }, [
					E('span', { 'style': 'flex:0 0 42px' }, '指令'), valInput, delBtn ])
			]);
			if (id)
				box.dataset.uciid = id;
			// newest on top
			list.insertBefore(box, list.firstChild);
		}

		// iterate in config order; prepending puts newest on top
		uci.sections('cpe-dashboard', 'at_cmd').forEach(function(s) {
			addRow(s['.name'], s.name, s.value);
		});

		var addBtn = E('button', { 'class': 'btn cbi-button-add', 'click': function() {
			addRow(null, '', '');
		} }, '新增指令');

		var saveBtn = E('button', { 'class': 'btn cbi-button-positive', 'click': function() {
			Array.prototype.forEach.call(list.querySelectorAll('.at-cmd-row'), function(row) {
				var inputs = row.querySelectorAll('input');
				var name = inputs[0].value.trim();
				var value = inputs[1].value.trim();
				if (!value)
					return;
				var id = row.dataset.uciid;
				if (!id) {
					id = 'quick' + Math.random().toString(36).slice(2, 10);
					row.dataset.uciid = id;
					uci.add('cpe-dashboard', 'at_cmd', id);
				}
				uci.set('cpe-dashboard', id, 'name', name || value);
				uci.set('cpe-dashboard', id, 'value', value);
			});
			dels.forEach(function(id) { uci.remove('cpe-dashboard', id); });
			dels.length = 0;
			uciCommit('cpe-dashboard').then(function() {
				if (reload)
					reload();
			});
		} }, '儲存');

		field.appendChild(list);
		field.appendChild(E('div', { 'style': 'margin-top:8px' }, [addBtn, ' ', saveBtn]));
		field.appendChild(E('div', { 'style': 'margin-top:6px; font-size:90%' },
			'自訂指令會以綠色按鈕顯示在上方快速指令列最前方（最新新增的排第一）；增修刪除後按「儲存」寫入 /etc/config/cpe-dashboard。'));
		section.appendChild(field);
		return section;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
