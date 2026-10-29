// prefs.js
// Preferences window for OwlPods using Libadwaita.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class OwlPodsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ----------------------------------------------------
        // PAGE 1: Устройство и Подключение
        // ----------------------------------------------------
        const devicePage = new Adw.PreferencesPage({
            title: 'Устройство',
            icon_name: 'bluetooth-active-symbolic',
        });

        const deviceGroup = new Adw.PreferencesGroup({
            title: 'Выбор AirPods',
            description: 'Привязка расширения к вашим наушникам для исключения реакции на чужие устройства.',
        });

        // Device Selection ComboRow
        const deviceModel = new Gtk.StringList();
        deviceModel.append('Автоопределение (любые AirPods рядом)');

        const deviceCombo = new Adw.ComboRow({
            title: 'Целевое устройство',
            subtitle: 'Выберите сопряженные AirPods',
            model: deviceModel,
        });

        // Load paired BlueZ devices asynchronously
        this._loadBluetoothDevices(deviceModel, deviceCombo, settings);

        deviceCombo.connect('notify::selected', () => {
            const idx = deviceCombo.selected;
            if (idx === 0) {
                settings.set_string('selected-device-mac', '');
                settings.set_string('selected-device-name', '');
            } else if (deviceCombo._deviceList && deviceCombo._deviceList[idx - 1]) {
                const dev = deviceCombo._deviceList[idx - 1];
                settings.set_string('selected-device-mac', dev.mac);
                settings.set_string('selected-device-name', dev.name);
            }
        });
        deviceGroup.add(deviceCombo);

        // Only Selected Device switch
        const onlySelectedRow = new Adw.SwitchRow({
            title: 'Игнорировать другие устройства',
            subtitle: 'Реагировать только на выбранные выше AirPods',
        });
        settings.bind('only-selected-device', onlySelectedRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        deviceGroup.add(onlySelectedRow);

        // RSSI Threshold slider
        const rssiAdjustment = new Gtk.Adjustment({
            lower: -95,
            upper: -35,
            step_increment: 1,
            page_increment: 5,
        });
        const rssiRow = new Adw.SpinRow({
            title: 'Порог расстояния (RSSI)',
            subtitle: 'Игнорировать кейсы дальше 1-1.5 метров (по умолчанию -70 dBm)',
            adjustment: rssiAdjustment,
        });
        settings.bind('rssi-threshold', rssiRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        deviceGroup.add(rssiRow);

        devicePage.add(deviceGroup);
        window.add(devicePage);

        // ----------------------------------------------------
        // PAGE 2: Анимация и Внешний вид
        // ----------------------------------------------------
        const appearancePage = new Adw.PreferencesPage({
            title: 'Анимация',
            icon_name: 'preferences-desktop-display-symbolic',
        });

        const popupGroup = new Adw.PreferencesGroup({
            title: 'Всплывающая карточка (Popup Card)',
            description: 'Настройка стиля модального окна в стиле iOS или macOS.',
        });

        // Style selector
        const styleModel = new Gtk.StringList();
        styleModel.append('iOS Style (Снизу по центру)');
        styleModel.append('macOS Style (Сверху справа)');

        const styleCombo = new Adw.ComboRow({
            title: 'Стиль и расположение карточки',
            model: styleModel,
            selected: settings.get_string('popup-style') === 'macos' ? 1 : 0,
        });
        styleCombo.connect('notify::selected', () => {
            settings.set_string('popup-style', styleCombo.selected === 1 ? 'macos' : 'ios');
        });
        popupGroup.add(styleCombo);

        // Duration
        const durationAdjustment = new Gtk.Adjustment({
            lower: 2,
            upper: 20,
            step_increment: 1,
            page_increment: 2,
        });
        const durationRow = new Adw.SpinRow({
            title: 'Время показа карточки (секунды)',
            subtitle: 'Автоматическое скрытие после открытия',
            adjustment: durationAdjustment,
        });
        settings.bind('popup-duration', durationRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        popupGroup.add(durationRow);

        // Triggers
        const showOnOpenRow = new Adw.SwitchRow({
            title: 'Показывать при открытии кейса',
            subtitle: 'Срабатывает мгновенно при открытии крышки рядом',
        });
        settings.bind('show-popup-on-open', showOnOpenRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        popupGroup.add(showOnOpenRow);

        const showOnConnectRow = new Adw.SwitchRow({
            title: 'Показывать при подключении Bluetooth',
            subtitle: 'Отображает заряд при подключении аудиоустройства',
        });
        settings.bind('show-popup-on-connect', showOnConnectRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        popupGroup.add(showOnConnectRow);

        appearancePage.add(popupGroup);

        // Top Panel Group
        const panelGroup = new Adw.PreferencesGroup({
            title: 'Верхняя панель GNOME',
        });

        const showPanelRow = new Adw.SwitchRow({
            title: 'Отображать значок на верхней панели',
            subtitle: 'Иконка AirPods и уровень заряда в системном трее',
        });
        settings.bind('show-panel-indicator', showPanelRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(showPanelRow);

        const panelDisplayModel = new Gtk.StringList();
        panelDisplayModel.append('Наименьший заряд (например 85%)');
        panelDisplayModel.append('Оба наушника (85% | 90%)');
        panelDisplayModel.append('Только иконка');

        const currentMode = settings.get_string('panel-display-mode');
        const selectedModeIdx = currentMode === 'compact' ? 1 : (currentMode === 'icon' ? 2 : 0);

        const panelModeCombo = new Adw.ComboRow({
            title: 'Формат отображения заряда',
            model: panelDisplayModel,
            selected: selectedModeIdx,
        });
        panelModeCombo.connect('notify::selected', () => {
            const val = panelModeCombo.selected === 1 ? 'compact' : (panelModeCombo.selected === 2 ? 'icon' : 'lowest');
            settings.set_string('panel-display-mode', val);
        });
        panelGroup.add(panelModeCombo);

        appearancePage.add(panelGroup);
        window.add(appearancePage);

        // ----------------------------------------------------
        // PAGE 3: Функции и Тестирование анимации
        // ----------------------------------------------------
        const featuresPage = new Adw.PreferencesPage({
            title: 'Функции и Демо',
            icon_name: 'emblem-favorite-symbolic',
        });

        const smartGroup = new Adw.PreferencesGroup({
            title: 'Умные возможности',
        });

        const earDetectionRow = new Adw.SwitchRow({
            title: 'Автопауза при извлечении из уха',
            subtitle: 'Приостанавливать плеер при извлечении одного или двух наушников',
        });
        settings.bind('ear-detection-pause', earDetectionRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        smartGroup.add(earDetectionRow);

        featuresPage.add(smartGroup);

        // Demo Testing Group
        const demoGroup = new Adw.PreferencesGroup({
            title: 'Тестирование анимации',
            description: 'Позволяет проверить анимацию карточки прямо сейчас на вашем мониторе.',
        });

        // Test Trigger Button
        const testActionRow = new Adw.ActionRow({
            title: 'Проверить анимацию сейчас',
            subtitle: 'Вызывает появление карточки открытия кейса AirPods Pro 3',
        });
        const testBtn = new Gtk.Button({
            label: 'Запустить',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        testBtn.connect('clicked', () => {
            const nextVal = (settings.get_int('trigger-demo') + 1) % 1000000;
            settings.set_int('trigger-demo', nextVal);
        });
        testActionRow.add_suffix(testBtn);
        demoGroup.add(testActionRow);

        featuresPage.add(demoGroup);
        window.add(featuresPage);
    }

    _loadBluetoothDevices(model, combo, settings) {
        // g_bus_get() has no Promise-based wrapper in GJS 1.90, and prefs.js
        // runs in a plain gjs process; use the synchronous call.
        try {
            const connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            const reply = connection.call_sync(
                'org.bluez',
                '/',
                'org.freedesktop.DBus.ObjectManager',
                'GetManagedObjects',
                null,
                new GLib.VariantType('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );

            const [objects] = reply.deepUnpack();
            const deviceList = [];
            let targetIdx = 0;
            const currentSavedMac = settings.get_string('selected-device-mac');

            for (const [path, interfaces] of Object.entries(objects)) {
                // a{sv} values are GVariants and must be deepUnpack()ed to get
                // plain JS strings; String(variant) yields "[object variant ...]".
                const dev = interfaces['org.bluez.Device1'];
                if (!dev || !dev.Address) {
                    continue;
                }
                const mac = dev.Address.deepUnpack();
                const alias = dev.Alias?.deepUnpack?.();
                const name = dev.Name?.deepUnpack?.();
                const deviceName = alias || name || 'Bluetooth Device';
                deviceList.push({ mac, name: deviceName });
                model.append(`${deviceName} (${mac})`);

                if (currentSavedMac && mac.toLowerCase() === currentSavedMac.toLowerCase()) {
                    targetIdx = deviceList.length; // offset by 1 for Auto item
                }
            }

            combo._deviceList = deviceList;
            combo.selected = targetIdx;
        } catch (e) {
            console.log(`[OwlPods] BlueZ devices enumerate note: ${e.message}`);
        }
    }
}
