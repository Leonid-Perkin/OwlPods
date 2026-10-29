// extension.js
// Main entry point for OwlPods GNOME Shell Extension.
// Target: GNOME Shell 51 (see gjs.guide porting guide for GNOME 51).

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { BluetoothService } from './src/bluetoothService.js';
import { PopupCard } from './src/popupCard.js';
import { Indicator } from './src/indicator.js';
import { MediaController } from './src/mediaController.js';

export default class OwlPodsExtension extends Extension {
    enable() {
        console.log('[OwlPods] Extension enable()');
        this._settings = this.getSettings();

        // 1. Initialize Bluetooth BLE and D-Bus Service
        this._bluetoothService = new BluetoothService(this._settings);

        // 2. Initialize Media Controller for Ear Detection Auto-Pause
        this._mediaController = new MediaController(this._settings);

        // 3. Initialize the Animated Popup Card
        this._popupCard = new PopupCard(this.path, this._settings);
        this._popupCard.setBluetoothService(this._bluetoothService);

        // 4. Initialize the Top Bar Panel Indicator
        this._indicator = new Indicator(this);
        this._indicator.setBluetoothService(this._bluetoothService);

        if (this._settings.get_boolean('show-panel-indicator')) {
            Main.panel.addToStatusArea('owlpods-indicator', this._indicator);
        }

        // Low battery notification state: highest threshold already notified
        // (-1 = nothing notified yet). Re-armed when battery rises above
        // the threshold + hysteresis.
        this._lowBatteryNotifiedLevel = -1;

        // Connect Bluetooth signals
        this._stateChangedId = this._bluetoothService.connect('state-changed', (service, state) => {
            this._indicator.updateState(state);
            if (state.inEar) {
                this._mediaController.handleEarState(state.inEar);
            }
            this._handleLowBatteryNotification(state);
        });

        this._lidOpenedId = this._bluetoothService.connect('case-lid-opened', (service, state) => {
            this._popupCard.show(state);
        });

        this._lidClosedId = this._bluetoothService.connect('case-lid-closed', () => {
            this._popupCard.dismiss();
        });

        // Watch settings changes
        this._settingsChangedId = this._settings.connect('changed::show-panel-indicator', () => {
            const show = this._settings.get_boolean('show-panel-indicator');
            if (show && !this._indicator.get_parent()) {
                Main.panel.addToStatusArea('owlpods-indicator', this._indicator);
            } else if (!show && this._indicator.get_parent()) {
                this._indicator.get_parent().remove_child(this._indicator);
            }
        });

        // Trigger demo animation from preferences
        this._triggerDemoChangedId = this._settings.connect('changed::trigger-demo', () => {
            console.log('[OwlPods] Demo animation triggered from prefs');
            if (this._popupCard) {
                this._popupCard.showDemo('open_case');
            }
        });
    }

    // Sends system notifications when the battery of any part crosses
    // 20% (low) or 10% (critical), once per crossing. Uses Main.notify(),
    // the standard Shell notification API (js/ui/main.js, GNOME Shell 51).
    _handleLowBatteryNotification(state) {
        if (!this._settings.get_boolean('low-battery-notification')) {
            this._lowBatteryNotifiedLevel = -1;
            return;
        }

        const parts = [
            ['Левый наушник', state.battery?.left, state.charging?.left],
            ['Правый наушник', state.battery?.right, state.charging?.right],
            ['Кейс', state.battery?.case, state.charging?.case],
        ];

        const valid = parts.filter(p => p[1] !== null && p[1] !== undefined);
        if (valid.length === 0) {
            return;
        }

        const anyCharging = valid.some(p => p[2]);
        if (anyCharging) {
            // On charger: everything will fill up, re-arm notifications.
            this._lowBatteryNotifiedLevel = -1;
            return;
        }

        const deviceName = state.deviceName || state.modelName || 'AirPods';
        const [worst] = valid.reduce((a, b) => (a[1] <= b[1] ? a : b));

        const level = worst[1] <= 10 ? 10 : (worst[1] <= 20 ? 20 : 0);

        if (level === 0) {
            // Re-arm once battery recovered above the low threshold.
            if (worst[1] > 25) {
                this._lowBatteryNotifiedLevel = -1;
            }
            return;
        }

        if (level > this._lowBatteryNotifiedLevel) {
            this._lowBatteryNotifiedLevel = level;
            const body = level === 10
                ? `${worst[0]}: ${worst[1]}% — срочно поставьте на зарядку`
                : `${worst[0]}: ${worst[1]}% — заряд скоро закончится`;
            Main.notify(deviceName, body);
        }
    }

    disable() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._triggerDemoChangedId) {
            this._settings.disconnect(this._triggerDemoChangedId);
            this._triggerDemoChangedId = 0;
        }

        if (this._bluetoothService) {
            if (this._stateChangedId) {
                this._bluetoothService.disconnect(this._stateChangedId);
                this._stateChangedId = 0;
            }
            if (this._lidOpenedId) {
                this._bluetoothService.disconnect(this._lidOpenedId);
                this._lidOpenedId = 0;
            }
            if (this._lidClosedId) {
                this._bluetoothService.disconnect(this._lidClosedId);
                this._lidClosedId = 0;
            }
            this._bluetoothService.destroy();
            this._bluetoothService = null;
        }

        if (this._mediaController) {
            this._mediaController.destroy();
            this._mediaController = null;
        }

        if (this._popupCard) {
            this._popupCard.destroy();
            this._popupCard = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._lowBatteryNotifiedLevel = -1;
        this._settings = null;
    }
}
