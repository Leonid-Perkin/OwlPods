// src/bluetoothService.js
// BlueZ D-Bus client for BLE Proximity Pairing packets and device connection management.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import { ProximityParser, APPLE_COMPANY_ID } from './proximityParser.js';

export const BluetoothService = GObject.registerClass({
    GTypeName: 'OwlPodsBluetoothService',
    Signals: {
        'state-changed': { param_types: [GObject.TYPE_JSOBJECT] },
        'case-lid-opened': { param_types: [GObject.TYPE_JSOBJECT] },
        'case-lid-closed': {},
        'connection-changed': { param_types: [GObject.TYPE_BOOLEAN, GObject.TYPE_STRING] },
    },
}, class BluetoothService extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._dbusConnection = null;
        this._propChangedSubId = 0;
        this._interfacesAddedSubId = 0;

        this._latestState = null;
        this._isConnected = false;
        this._connectedMac = '';
        this._connectedDeviceName = '';
        this._adapterPath = null; // resolved from org.bluez.Adapter1
        this._adapterProxy = null;
        this._destroyed = false;

        // Registry keyed by BlueZ object path. PropertiesChanged carries ONLY
        // the changed properties (no Name/Address/UUIDs), so identity must be
        // restored from the initial GetManagedObjects scan — otherwise our own
        // paired AirPods "connect invisibly" and the panel never updates.
        this._deviceRegistryByPath = new Map();

        // Per-device lid state. Nobody's shared `_latestState` must mix beacons
        // of different nearby devices: that produced endless open→close→open
        // transitions and repeated popups ("demo constantly spinning").
        this._lidOpenByMac = new Map();
        // Last parsed beacon per MAC: used to show THIS device's own data on
        // the connect popup instead of whatever `_latestState` holds.
        this._parsedByMac = new Map();
        // Rotating bud addresses recognized as belonging to the paired set.
        // Each bud of the case advertises its own RPA, so a strict MAC match
        // against the paired device must be relaxed for these.
        this._familyMacs = new Set();
        // Target model id ("2720" style): the BLE proximity packet encodes the
        // paired device's Modalias product id with the nibble halves swapped
        // (live-proven: Modalias p2027 of AirPods Pro 3 -> beacons 0x2720).
        // Each bud advertises from a rotating address, so the model id is the
        // only stable way to recognize OUR set — battery visibility depends
        // on this, not on MAC equality.
        this._targetModel = '';
        // Global popup rate limit: at most one `case-lid-opened` per 10 s
        // no matter how many Apple devices are advertising around us.
        this._lastPopupEmitMs = 0;
        // Journal diagnostics throttles (battery changes and weak beacons).
        this._lastPublishLogKey = '';
        this._lastWeakLogMs = 0;
        this._lastSuppressLogMs = 0;
        // Delayed connect popup: buds connect within ~0.5 s of lid-open, so an
        // instant popup pre-empts the first proximity beacon and shows dashes
        // — and pre-showing means the entrance animation does not replay
        // ("animation doesn't always play after opening the lid").
        this._connectPopupTimerId = 0;
        // Discovery watchdog: other components can call StopDiscovery (or
        // toggle the adapter), silently killing our beacon feed.
        this._discoveryWatchdogId = 0;

        this._initDBus();
    }

    _initDBus() {
        // g_bus_get() has no Promise-based wrapper in GJS 1.90 ("At least 3
        // arguments required"), so the synchronous variant is used explicitly.
        try {
            this._dbusConnection = Gio.bus_get_sync(
                Gio.BusType.SYSTEM,
                this._cancellable
            );

            // Subscribe to PropertiesChanged on org.bluez
            this._propChangedSubId = this._dbusConnection.signal_subscribe(
                'org.bluez',
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                null,
                null,
                Gio.DBusSignalFlags.NONE,
                this._onPropertiesChanged.bind(this)
            );

            // Subscribe to InterfacesAdded (for new devices during scan)
            this._interfacesAddedSubId = this._dbusConnection.signal_subscribe(
                'org.bluez',
                'org.freedesktop.DBus.ObjectManager',
                'InterfacesAdded',
                null,
                null,
                Gio.DBusSignalFlags.NONE,
                this._onInterfacesAdded.bind(this)
            );

            // Sequential startup: the adapter path must be resolved by the
            // scan BEFORE discovery is configured. Both run concurrently
            // earlier and `_setupDiscovery` always saw a null `_adapterPath`,
            // logging a misleading "falling back to hci0" even on real
            // sessions with adapters.
            this._startupScanAndListen();
        } catch (e) {
            if (!this._destroyed) {
                console.error(`[OwlPods] DBus initialization failed: ${e.message}`);
            }
        }
    }

    async _startupScanAndListen() {
        await this._scanExistingDevices();
        await this._setupDiscovery();
        this._startDiscoveryWatchdog();
    }

    async _setupDiscovery() {
        try {
            if (this._destroyed) {
                return;
            }

            if (!this._adapterPath) {
                // GetManagedObjects really had no adapter: BlueZ is down or
                // the radio is soft-blocked. The fallback keeps calls alive.
                this._adapterPath = '/org/bluez/hci0';
                console.log('[OwlPods] No org.bluez.Adapter1 found, falling back to hci0');
            }

            // Set discovery filter to receive LE packets and duplicate beacons
            const filterVariant = new GLib.Variant('(a{sv})', [{
                Transport: GLib.Variant.new_string('le'),
                DuplicateData: GLib.Variant.new_boolean(true),
            }]);

            await this._dbusConnection.call(
                'org.bluez',
                this._adapterPath,
                'org.bluez.Adapter1',
                'SetDiscoveryFilter',
                filterVariant,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable
            );

            // The reply may arrive after disable(); bail out silently.
            if (this._destroyed) {
                return;
            }

            // Start passive discovery if adapter is powered
            try {
                await this._dbusConnection.call(
                    'org.bluez',
                    this._adapterPath,
                    'org.bluez.Adapter1',
                    'StartDiscovery',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    this._cancellable
                );
            } catch (scanErr) {
                // If discovery is already running, that's fine
            }
        } catch (e) {
            console.log(`[OwlPods] SetDiscoveryFilter note: ${e.message}`);
        }
    }

    _startDiscoveryWatchdog() {
        if (this._discoveryWatchdogId || this._destroyed) {
            return;
        }
        this._discoveryWatchdogId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            () => {
                if (this._destroyed) {
                    this._discoveryWatchdogId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._ensureDiscoveryRunning();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    async _ensureDiscoveryRunning() {
        if (this._destroyed || !this._adapterPath || !this._dbusConnection) {
            return;
        }
        try {
            const reply = await this._dbusConnection.call(
                'org.bluez',
                this._adapterPath,
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.bluez.Adapter1', 'Discovering']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable
            );
            const [discoveringVar] = reply.deepUnpack();
            if (!discoveringVar.get_boolean()) {
                console.log('[OwlPods] Discovery stopped by another component, restarting');
                await this._setupDiscovery();
            }
        } catch (e) {
            // Cancelled (disable) or adapter vanished — nothing to do.
        }
    }

    async _scanExistingDevices() {
        try {
            const reply = await this._dbusConnection.call(
                'org.bluez',
                '/',
                'org.freedesktop.DBus.ObjectManager',
                'GetManagedObjects',
                null,
                new GLib.VariantType('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable
            );

            // The DBus reply may arrive after disable(); bail out silently.
            if (this._destroyed) {
                return;
            }

            const [managedObjects] = reply.deepUnpack();
            for (const [path, interfaces] of Object.entries(managedObjects)) {
                // Pick the first Bluetooth adapter instead of hardcoding hci0
                if (interfaces['org.bluez.Adapter1'] && this._adapterPath === null) {
                    this._adapterPath = path;
                }
                if (interfaces['org.bluez.Device1']) {
                    this._processDeviceProperties(path, interfaces['org.bluez.Device1']);
                }
                // Battery1 may already exist for the selected device at startup
                // (esp. after relogin with connected buds): InterfacesAdded only
                // reports NEW interfaces, so the initial scan must process it.
                if (interfaces['org.bluez.Battery1']) {
                    const bat = interfaces['org.bluez.Battery1'];
                    if (bat.Percentage !== undefined) {
                        const percent = bat.Percentage.deepUnpack
                            ? bat.Percentage.deepUnpack()
                            : bat.Percentage;
                        this._processBattery1Percentage(percent, path);
                    }
                }
            }
        } catch (e) {
            // Gio.IOErrorEnum.CANCELLED is expected on extension disable
            if (!this._destroyed) {
                console.error(`[OwlPods] Failed to get managed objects: ${e.message}`);
            }
        }
    }

    _onInterfacesAdded(connection, sender, path, interfaceName, signalName, parameters) {
        if (this._destroyed) return;
        const [objPath, interfaces] = parameters.deepUnpack();
        if (interfaces['org.bluez.Device1']) {
            this._registerDevice(objPath, interfaces['org.bluez.Device1']);
            this._processDeviceProperties(objPath, interfaces['org.bluez.Device1']);
        }
        // Battery1 does not exist from the start: the interface APPEARS when
        // the device connects (GATT battery resolves). Handle it here too.
        if (interfaces['org.bluez.Battery1']) {
            const bat = interfaces['org.bluez.Battery1'];
            if (bat.Percentage !== undefined) {
                const percent = bat.Percentage.deepUnpack ? bat.Percentage.deepUnpack() : bat.Percentage;
                this._processBattery1Percentage(percent, objPath);
            }
        }
    }

    _registerDevice(path, props) {
        let reg = this._deviceRegistryByPath.get(path);
        if (!reg) {
            reg = {};
            this._deviceRegistryByPath.set(path, reg);
        }

        const unpack = v => (v && v.deepUnpack ? v.deepUnpack() : v);

        if (props.Address !== undefined) reg.address = String(unpack(props.Address));
        if (props.Name !== undefined) reg.name = String(unpack(props.Name));
        else if (props.Alias !== undefined) reg.name = reg.name || String(unpack(props.Alias));
        if (props.UUIDs !== undefined) {
            const raw = unpack(props.UUIDs);
            if ( Array.isArray(raw)) reg.uuids = raw.map(u => String(u).toLowerCase());
        }
        if (props.Paired !== undefined) reg.paired = Boolean(unpack(props.Paired));
        if (props.Modalias !== undefined) reg.modalias = String(unpack(props.Modalias));
        return reg;
    }

    _targetModelFromModalias(modalias) {
        if (!modalias) {
            return '';
        }
        const match = String(modalias).match(/v004Cp([0-9A-Fa-f]{4})d/i);
        if (!match) {
            return '';
        }
        const detected = match[1].toUpperCase();
        // The proximity packet encodes the model with the halves of the
        // Modalias product id swapped (live-proven on this machine: the
        // paired AirPods Pro report Modalias p2027 while their beacons
        // carry model id 0x2720).
        return detected.substring(2) + detected.substring(0, 2);
    }

    _updateTargetModel() {
        const wanted = [
            this._connectedMac,
            this._settings.get_string('selected-device-mac'),
        ].filter(Boolean);
        for (const mac of wanted) {
            const wantedLower = mac.toLowerCase();
            for (const reg of this._deviceRegistryByPath.values()) {
                if (reg.address && reg.address.toLowerCase() === wantedLower && reg.modalias) {
                    const model = this._targetModelFromModalias(reg.modalias);
                    if (model) {
                        this._targetModel = model;
                        return;
                    }
                }
            }
        }
    }

    _scheduleConnectPopup(initialState) {
        if (this._connectPopupTimerId) {
            GLib.source_remove(this._connectPopupTimerId);
        }
        this._connectPopupTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            800,
            () => {
                this._connectPopupTimerId = 0;
                if (this._destroyed) {
                    return GLib.SOURCE_REMOVE;
                }
                // A lid-beacon popup fired meanwhile — don't echo it.
                if (Date.now() - this._lastPopupEmitMs < 1200) {
                    return GLib.SOURCE_REMOVE;
                }
                // Recompute the freshest own beacon at fire time: packets that
                // arrived during the delay now carry the real battery.
                const beaconState = this._connectedMac
                    ? this._parsedByMac.get(this._connectedMac.toUpperCase())
                    : null;
                let family = null;
                for (const macKey of this._familyMacs) {
                    const candidate = this._parsedByMac.get(macKey);
                    if (candidate && (!family || candidate.timestamp > family.timestamp)) {
                        family = candidate;
                    }
                }
                const fresh = beaconState || family || null;
                const merged = Object.assign({}, fresh || initialState, {
                    deviceName: this._connectedDeviceName || (fresh || initialState).deviceName,
                    mac: this._connectedMac,
                });
                this._latestState = merged;
                this.emit('state-changed', merged);
                this._lastPopupEmitMs = Date.now();
                this.emit('case-lid-opened', merged);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _onPropertiesChanged(connection, sender, path, interfaceName, signalName, parameters) {
        if (this._destroyed) return;
        const [targetInterface, changedProps] = parameters.deepUnpack();
        if (targetInterface === 'org.bluez.Device1') {
            this._processDeviceProperties(path, changedProps);
        } else if (targetInterface === 'org.bluez.Battery1') {
            if ('Percentage' in changedProps) {
                this._processBattery1Percentage(changedProps.Percentage, path);
            }
        }
    }

    _processDeviceProperties(path, props) {
        if (this._destroyed || !props) return;

        const unpack = v => (v && v.deepUnpack ? v.deepUnpack() : v);

        // Merge with the registry: PropertiesChanged updates carry only the
        // changed keys, so Name/Address/UUIDs must be restored from the
        // earlier scan or from InterfacesAdded.
        const registry = this._registerDevice(path, props);

        const mac = props.Address !== undefined ? String(unpack(props.Address))
            : (registry.address || '');
        const name = props.Name !== undefined ? String(unpack(props.Name))
            : (props.Alias !== undefined ? String(unpack(props.Alias))
            : (registry.name || ''));
        const rssi = props.RSSI !== undefined ? unpack(props.RSSI) : -100;
        const connected = props.Connected !== undefined ? Boolean(unpack(props.Connected)) : null;

        let uuidsList = [];
        if (props.UUIDs !== undefined) {
            const rawUuids = unpack(props.UUIDs);
            if (Array.isArray(rawUuids)) {
                uuidsList = rawUuids.map(u => String(u).toLowerCase());
            }
        } else if (registry.uuids) {
            uuidsList = registry.uuids;
        }

        // Check if device is AirPods by Apple UUID or Name
        const isAirPodsUuid = uuidsList.includes('74ec2172-0bad-4d01-8f77-997b2be0722a');
        const isAirPodsName = name.toLowerCase().includes('airpods');

        if (connected !== null) {
            if (isAirPodsUuid || isAirPodsName) {
                const changed = this._isConnected !== connected;
                this._isConnected = connected;
                this._connectedMac = mac;
                this._connectedDeviceName = name || 'AirPods';

                // Auto-bind device if setting is empty
                const savedMac = this._settings.get_string('selected-device-mac');
                if (!savedMac && connected) {
                    this._settings.set_string('selected-device-mac', mac);
                    this._settings.set_string('selected-device-name', this._connectedDeviceName);
                }

                if (changed) {
                    this.emit('connection-changed', connected, this._connectedDeviceName);
                    if (connected) {
                        // Family recognition: right before these buds connect, the
                        // SAME SET advertised its docked-open status from rotating
                        // RPA addresses. A strict MAC match can never see those,
                        // so the recent beacons within a 10 s window belong to this
                        // device: trust them and adopt the freshest as its state.
                        const nowMs = Date.now();
                        let freshest = null;
                        for (const [macKey, beaconParsed] of this._parsedByMac) {
                            if (!beaconParsed?.timestamp) {
                                continue;
                            }
                            if (nowMs - beaconParsed.timestamp <= 10000) {
                                this._familyMacs.add(macKey);
                                if (!freshest || beaconParsed.timestamp > freshest.timestamp) {
                                    freshest = beaconParsed;
                                }
                            }
                        }
                        if (freshest) {
                            this._parsedByMac.set(
                                this._connectedMac.toUpperCase(),
                                Object.assign({}, freshest, {
                                    deviceName: this._connectedDeviceName || freshest.deviceName,
                                    mac: this._connectedMac,
                                })
                            );
                        }

                        // Refresh the panel right away: menu title/subtitle.
                        const beaconState = this._connectedMac
                            ? this._parsedByMac.get(this._connectedMac.toUpperCase())
                            : null;
                        const merged = beaconState ? Object.assign({}, beaconState, {
                            deviceName: name || beaconState.deviceName,
                            mac: this._connectedMac,
                        }) : {
                            deviceName: this._connectedDeviceName || 'AirPods',
                            modelName: this._connectedDeviceName || 'AirPods',
                            battery: { left: null, right: null, case: null },
                            charging: { left: false, right: false, case: false },
                            inEar: { left: false, right: false },
                            isPairingMode: false,
                            mac: this._connectedMac,
                            timestamp: Date.now(),
                        };
                        this._latestState = merged;
                        this.emit('state-changed', merged);

                        if (this._settings.get_boolean('show-popup-on-connect')) {
                            console.log(`[OwlPods] AirPods connected: ${this._connectedDeviceName || 'AirPods'} (${this._connectedMac})`);
                            // Delayed: gives the first lid-open beacon ~0.8 s to
                            // land, so the popup carries real battery AND plays
                            // its entrance animation (an instant popup while a
                            // beacon is still in flight pre-empts both).
                            this._scheduleConnectPopup(merged);
                        }
                    }
                }
            }
        }

        // Refresh the target model whenever the target device is seen: Modalias
        // arrives via the initial scan / InterfacesAdded, not necessarily with
        // the connect event itself.
        this._updateTargetModel();

        // Process ManufacturerData
        if (props.ManufacturerData) {
            const mData = props.ManufacturerData.deepUnpack ? props.ManufacturerData.deepUnpack() : props.ManufacturerData;
            const appleData = mData[APPLE_COMPANY_ID] || mData[76];
            if (appleData) {
                const bytes = appleData.deepUnpack ? appleData.deepUnpack() : appleData;
                // PropertiesChanged payloads do NOT carry Address; passing the
                // object path lets the beacon handler restore the MAC.
                this._handleAppleBeacon(bytes, mac, name, rssi, path);
            }
        }
    }

    _handleAppleBeacon(rawBytes, mac, name, rssi, devicePath = null) {
        if (this._destroyed) return;
        const parsed = ProximityParser.parse(rawBytes);
        if (!parsed) {
            return;
        }

        // PropertiesChanged updates do not include Address. Restore the MAC
        // from the BlueZ object path ("/org/bluez/hci0/dev_XX_YY_...") so
        // beacons of the PAIRED device are not dropped as "unknown MAC".
        if (!mac && devicePath) {
            const match = devicePath.match(/dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})/);
            if (match) {
                mac = match[1].replace(/_/g, ':').toUpperCase();
            }
        }

        // Beacon model id in "2720" text form, and whether it matches the
        // paired device's rotated Modalias. Bud addresses ROTATE (RPA), so
        // model equality is the only reliable family signal.
        const beaconModel = parsed.modelId
            ? parsed.modelId.toString(16).toUpperCase().padStart(4, '0')
            : '';
        const matchesTargetModel = Boolean(this._targetModel) && beaconModel === this._targetModel.toUpperCase();

        // Apply filters: RSSI threshold
        const rssiThreshold = this._settings.get_int('rssi-threshold');
        if (rssi !== undefined && rssi < rssiThreshold) {
            // Signal too weak (likely neighbor's device)
            if (matchesTargetModel) {
                // Diagnostics: explain why a docked/open set far away shows
                // nothing even though its model matches.
                const nowMs = Date.now();
                if (nowMs - this._lastWeakLogMs > 30000) {
                    this._lastWeakLogMs = nowMs;
                    console.log(`[OwlPods] Target-model beacon too weak: RSSI ${rssi} < ${rssiThreshold}`);
                }
            }
            return;
        }

        // NOTE: there is deliberately NO hard MAC filter here. Stranger
        // beacons are rejected below by the target cascade: exact MAC,
        // connected MAC, memorized family RPA or matching target model.
        parsed.rssi = rssi;
        parsed.mac = mac;
        parsed.deviceName = name || parsed.modelName;

        // Lid transitions are tracked per MAC address. Each nearby Apple
        // device has its own case-lid state; blending them into one shared
        // `_latestState` used to flip the "lid opened" edge forever and
        // re-trigger the popup ("demo constantly spinning").
        const macKey = (mac || 'no-mac').toUpperCase();
        this._parsedByMac.set(macKey, parsed);

        const previousLidOpen = this._lidOpenByMac.get(macKey) ?? null;
        const nowLidOpen = parsed.caseState?.isLidOpen === true;
        this._lidOpenByMac.set(macKey, nowLidOpen);

        // The published state (panel indicator, media ear detection, battery
        // notifications) must come only from our own device: exact MAC,
        // connected MAC, adopted family RPA or target MODEL match.
        // Beacons of strangers previously overwrote it ("wrong data" report).
        const selectedMac = this._settings.get_string('selected-device-mac');
        const isTargetBeacon =
            (selectedMac && mac && selectedMac.toLowerCase() === mac.toLowerCase()) ||
            (this._connectedMac && mac && this._connectedMac.toLowerCase() === mac.toLowerCase()) ||
            this._familyMacs.has(macKey) ||
            matchesTargetModel;
        const hasTarget = Boolean(selectedMac) || Boolean(this._connectedMac);

        // BlueZ names freshly discovered LE devices by their address
        // ("79-96-05-91-D4-31") until the name resolves. Rotating bud
        // addresses never resolve, so numeric aliases must not become the
        // popup title — the decoded model name is always more truthful.
        if (/^[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5}$/.test(name || '')) {
            parsed.deviceName = parsed.modelName;
        }
        // If these buds belong to our PAIRED set (and it is connected), the
        // real user-given name is known: use it for title/subtitle context.
        if (isTargetBeacon && this._isConnected && this._connectedDeviceName) {
            parsed.deviceName = this._connectedDeviceName;
        }

        if (isTargetBeacon) {
            // Log only on change so the journal stays readable with beacons
            // arriving every second or two.
            const batteryText = `${parsed.battery.left}/${parsed.battery.right}/${parsed.battery.case}`;
            const publishKey = `${macKey}:${batteryText}`;
            if (publishKey !== this._lastPublishLogKey) {
                this._lastPublishLogKey = publishKey;
                console.log(
                    `[OwlPods] Target beacon: ${parsed.deviceName || parsed.modelName}` +
                    ` (${mac}) RSSI ${rssi ?? '?'} dBm battery L/R/C ${batteryText}`
                );
            }
            this._latestState = parsed;
            this.emit('state-changed', parsed);
        } else if (hasTarget) {
            // A target exists: strangers must not trigger popups either.
            return;
        }

        // Lid opening transition, for THIS device only
        if (nowLidOpen && previousLidOpen !== true) {
            // Global rate limit: one popup per 10 s across all devices, so a
            // street full of AirPods cannot open popups in a loop. Real
            // repeated user actions stay possible after the cooldown.
            const now = Date.now();
            if (now - this._lastPopupEmitMs < 10000) {
                // Diagnostics: a suppressed popup is invisible to the user —
                // leave a throttled trace in the journal so "no popup after
                // opening the case" can be distinguished from "no beacon".
                if (now - this._lastSuppressLogMs > 30000) {
                    this._lastSuppressLogMs = now;
                    console.log(
                        `[OwlPods] Popup rate-limited` +
                        ` (${Math.round((now - this._lastPopupEmitMs) / 1000)} s since last)`
                    );
                }
                return;
            }

            if (this._settings.get_boolean('show-popup-on-open')) {
                this._lastPopupEmitMs = now;
                console.log(
                    `[OwlPods] Beacon popup: ${parsed.deviceName}` +
                    ` (${mac || 'no mac'}) RSSI ${rssi ?? 'n/a'} dBm`
                );
                this.emit('case-lid-opened', parsed);
            }
        } else if (!nowLidOpen && previousLidOpen === true) {
            this.emit('case-lid-closed');
        }
    }

    _processBattery1Percentage(percent, devicePath = null) {
        if (this._destroyed) return;

        // Battery1 exists for many devices (a BT mouse exposes one too).
        // Only the selected or connected AirPods may update headphones state,
        // otherwise foreign batteries posed as "ear in" ("wrong data" report).
        const targetMac = this._connectedMac || this._settings.get_string('selected-device-mac');
        if (!targetMac || !devicePath) {
            return;
        }
        const match = devicePath.match(/dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})/);
        if (!match) {
            return;
        }
        const pathMac = match[1].replace(/_/g, ':').toLowerCase();
        if (pathMac !== targetMac.toLowerCase()) {
            return;
        }

        if (!this._latestState) {
            this._latestState = {
                modelName: this._connectedDeviceName || 'AirPods',
                battery: { left: percent, right: percent, case: null },
                charging: { left: false, right: false, case: false },
                inEar: { left: true, right: true },
                caseState: { isLidOpen: false },
                timestamp: Date.now(),
            };
        } else {
            // Update lowest pod percentage if both connected
            if (this._latestState.battery.left === null) this._latestState.battery.left = percent;
            if (this._latestState.battery.right === null) this._latestState.battery.right = percent;
        }
        this.emit('state-changed', this._latestState);
    }

    // The popup's "Connect" often fires with a rotating beacon address
    // (RPA): an unpaired LE endpoint without audio profiles. Connecting
    // that never activates the buds. Resolve to the PAIRED set whenever we
    // know it: the configured selection wins, then the currently connected
    // address, and only as a last resort the passed address itself
    // (selection-less setups can't do better than the advertised endpoint).
    resolveConnectTarget(mac) {
        const selectedMac = ((this._settings && this._settings.get_string('selected-device-mac')) || '').trim();
        if (selectedMac) {
            return selectedMac;
        }
        if (this._isConnected && this._connectedMac) {
            return this._connectedMac;
        }
        return mac || null;
    }

    async connectDevice(mac) {
        const devicePath = this._buildDevicePath(mac);
        if (!devicePath || !this._dbusConnection) return false;
        try {
            await this._dbusConnection.call(
                'org.bluez',
                devicePath,
                'org.bluez.Device1',
                'Connect',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable
            );
            return true;
        } catch (e) {
            console.error(`[OwlPods] Connect error: ${e.message}`);
            return false;
        }
    }

    async disconnectDevice(mac) {
        const devicePath = this._buildDevicePath(mac);
        if (!devicePath || !this._dbusConnection) return false;
        try {
            await this._dbusConnection.call(
                'org.bluez',
                devicePath,
                'org.bluez.Device1',
                'Disconnect',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable
            );
            return true;
        } catch (e) {
            console.error(`[OwlPods] Disconnect error: ${e.message}`);
            return false;
        }
    }

    _buildDevicePath(mac) {
        if (!mac) {
            return null;
        }
        return `${this._adapterPath || '/org/bluez/hci0'}/dev_${mac.replace(/:/g, '_')}`;
    }

    getLatestState() {
        return this._latestState;
    }

    isConnected() {
        return this._isConnected;
    }

    getConnectedDeviceName() {
        return this._connectedDeviceName || (this._latestState?.modelName) || 'AirPods';
    }

    destroy() {
        // Guards all pending async continuations against emitting events
        // after the extension has been disabled (prevents the "Object St.Label
        // has been already disposed" spam seen at shell shutdown).
        this._destroyed = true;
        this._cancellable.cancel();

        if (this._connectPopupTimerId) {
            GLib.source_remove(this._connectPopupTimerId);
            this._connectPopupTimerId = 0;
        }
        if (this._discoveryWatchdogId) {
            GLib.source_remove(this._discoveryWatchdogId);
            this._discoveryWatchdogId = 0;
        }

        // Fire-and-forget StopDiscovery: do not leave the adapter scanning
        // after the extension has been disabled.
        this._dbusConnection?.call?.(
            'org.bluez',
            this._adapterPath || '/org/bluez/hci0',
            'org.bluez.Adapter1',
            'StopDiscovery',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        ).catch?.(() => {});

        if (this._dbusConnection) {
            if (this._propChangedSubId) {
                this._dbusConnection.signal_unsubscribe(this._propChangedSubId);
            }
            if (this._interfacesAddedSubId) {
                this._dbusConnection.signal_unsubscribe(this._interfacesAddedSubId);
            }
        }
        this._settings = null;
    }
});
