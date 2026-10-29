// src/indicator.js
// Top bar panel indicator and popup menu for AirPods Pro.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const Indicator = GObject.registerClass({
    GTypeName: 'OwlPodsIndicator',
}, class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'OwlPods');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._bluetoothService = null;
        this._currentState = null;
        this._destroyed = false;

        // Panel Box
        this._box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box owlpods-panel-box',
        });

        // Icon
        const iconPath = `${this._extension.path}/assets/owlpods-symbolic.svg`;
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon owlpods-panel-icon',
        });
        this._box.add_child(this._icon);

        // Label
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'owlpods-panel-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._buildMenu();
    }

    setBluetoothService(service) {
        this._bluetoothService = service;
    }

    _buildMenu() {
        this.menu.removeAll();

        // Title Row
        this._menuTitleItem = new PopupMenu.PopupMenuItem('AirPods Pro 3', {
            reactive: false,
            style_class: 'owlpods-menu-title',
        });
        this.menu.addMenuItem(this._menuTitleItem);

        this._menuSubtitleItem = new PopupMenu.PopupMenuItem('Не подключено', {
            reactive: false,
            style_class: 'owlpods-menu-subtitle',
        });
        this.menu.addMenuItem(this._menuSubtitleItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Status items: Left, Right, Case
        this._leftItem = new PopupMenu.PopupMenuItem('Левый наушник: --', { reactive: false });
        this._rightItem = new PopupMenu.PopupMenuItem('Правый наушник: --', { reactive: false });
        this._caseItem = new PopupMenu.PopupMenuItem('Кейс: --', { reactive: false });

        this.menu.addMenuItem(this._leftItem);
        this.menu.addMenuItem(this._rightItem);
        this.menu.addMenuItem(this._caseItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Demo Actions Section
        const demoHeader = new PopupMenu.PopupMenuItem('Тестирование и Демо:', {
            reactive: false,
            style_class: 'owlpods-menu-section-header',
        });
        this.menu.addMenuItem(demoHeader);

        const testOpenItem = new PopupMenu.PopupMenuItem('▶ Показать анимацию (Открытие кейса)');
        testOpenItem.connect('activate', () => {
            if (this._extension && this._extension._popupCard) {
                this._extension._popupCard.showDemo('open_case');
            }
        });
        this.menu.addMenuItem(testOpenItem);

        const testChargingItem = new PopupMenu.PopupMenuItem('⚡ Тест режима зарядки');
        testChargingItem.connect('activate', () => {
            if (this._extension && this._extension._popupCard) {
                this._extension._popupCard.showDemo('charging');
            }
        });
        this.menu.addMenuItem(testChargingItem);

        const testLowItem = new PopupMenu.PopupMenuItem('🪫 Тест низкого заряда');
        testLowItem.connect('activate', () => {
            if (this._extension && this._extension._popupCard) {
                this._extension._popupCard.showDemo('low_battery');
            }
        });
        this.menu.addMenuItem(testLowItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Preferences Button
        const prefsItem = new PopupMenu.PopupMenuItem('Настройки расширения...');
        prefsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(prefsItem);
    }

    destroy() {
        // Null the child references so late updateState() calls
        // cannot touch disposed St.Label objects.
        this._destroyed = true;
        this._label = null;
        this._menuTitleItem = null;
        this._menuSubtitleItem = null;
        this._leftItem = null;
        this._rightItem = null;
        this._caseItem = null;
        this._bluetoothService = null;
        this._extension = null;
        this._settings = null;
        super.destroy();
    }

    updateState(state) {
        if (!this._label || this._destroyed) {
            return;
        }

        this._currentState = state;
        if (!state) {
            this._label.text = '';
            return;
        }

        // Title update
        const name = state.deviceName || state.modelName || 'AirPods Pro 3';
        this._menuTitleItem.label.text = name;

        // Subtitle
        if (state.isPairingMode) {
            this._menuSubtitleItem.label.text = 'Режим сопряжения';
        } else {
            this._menuSubtitleItem.label.text = state.mac ? `Подключено (${state.mac})` : 'Рядом';
        }

        // Left Pod
        const leftBat = state.battery?.left;
        const leftChg = state.charging?.left ? ' ⚡' : '';
        const leftInEar = state.inEar?.left ? ' (В ухе)' : '';
        this._leftItem.label.text = `Левый: ${leftBat !== null && leftBat !== undefined ? leftBat + '%' : '--'}${leftChg}${leftInEar}`;

        // Right Pod
        const rightBat = state.battery?.right;
        const rightChg = state.charging?.right ? ' ⚡' : '';
        const rightInEar = state.inEar?.right ? ' (В ухе)' : '';
        this._rightItem.label.text = `Правый: ${rightBat !== null && rightBat !== undefined ? rightBat + '%' : '--'}${rightChg}${rightInEar}`;

        // Case
        const caseBat = state.battery?.case;
        const caseChg = state.charging?.case ? ' ⚡' : '';
        this._caseItem.label.text = `Кейс: ${caseBat !== null && caseBat !== undefined ? caseBat + '%' : '--'}${caseChg}`;

        // Panel label update according to setting
        const mode = this._settings.get_string('panel-display-mode') || 'lowest';
        if (mode === 'icon') {
            this._label.text = '';
        } else if (mode === 'compact') {
            const l = leftBat !== null && leftBat !== undefined ? `${leftBat}%` : '-';
            const r = rightBat !== null && rightBat !== undefined ? `${rightBat}%` : '-';
            this._label.text = ` ${l} | ${r}`;
        } else {
            // 'lowest' mode
            const valid = [leftBat, rightBat].filter(v => v !== null && v !== undefined);
            if (valid.length > 0) {
                const min = Math.min(...valid);
                const charging = state.charging?.left || state.charging?.right ? '⚡' : '';
                this._label.text = ` ${min}%${charging}`;
            } else {
                this._label.text = '';
            }
        }
    }
});
