// src/popupCard.js
// iOS and macOS style animated modal card for AirPods Pro.
// GNOME 51: uses Clutter.ClickGesture and actor hover tracking
// instead of deprecated event signals (per gjs.guide/GNOME Shell 51 porting guide).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { BatteryRing } from './animatedBatteryRing.js';

export const PopupCard = GObject.registerClass({
    GTypeName: 'OwlPodsPopupCard',
}, class PopupCard extends GObject.Object {
    _init(extensionPath, settings) {
        super._init();
        this._extensionPath = extensionPath;
        this._settings = settings;

        this._container = null;
        this._card = null;
        this._leftRing = null;
        this._rightRing = null;
        this._caseRing = null;

        this._leftPctLabel = null;
        this._rightPctLabel = null;
        this._casePctLabel = null;

        this._leftStatusLabel = null;
        this._rightStatusLabel = null;
        this._caseStatusLabel = null;

        this._titleLabel = null;
        this._subtitleLabel = null;

        this._dismissTimerId = 0;
        this._isShowing = false;
        this._currentState = null;
        this._bluetoothService = null;
        this._destroyed = false;
    }

    setBluetoothService(service) {
        this._bluetoothService = service;
    }

    _buildCard() {
        if (this._destroyed) {
            return;
        }

        if (this._container && this._card) {
            return;
        }

        if (this._container) {
            this._container.destroy();
            this._container = null;
        }

        // Fullscreen overlay to detect clicks outside
        this._container = new St.Widget({
            style_class: 'owlpods-modal-overlay',
            reactive: true,
            x: 0,
            y: 0,
        });

        // Click-outside-to-dismiss, the exact upstream GNOME Shell 51 pattern
        // (js/ui/popupMenu.js, PopupMenuManager): gate recognition with
        // 'may-recognize' so clicks on the card itself (close/connect buttons)
        // never reach this gesture, and recognize right on press.
        const clickGesture = new Clutter.ClickGesture({
            recognize_on_press: true,
        });
        clickGesture.connect('may-recognize', () => {
            if (!this._card) {
                return false;
            }
            const event = clickGesture.get_point_event(0);
            const targetActor = global.stage.get_event_actor(event);
            return !this._card.contains(targetActor);
        });
        clickGesture.connect('recognize', () => this.dismiss());
        this._container.add_action(clickGesture);

        // The card itself. Auto-dismiss is unconditional: the popup always
        // closes after popup-duration seconds. Hover pause was removed on
        // purpose — it could freeze the popup on screen forever while the
        // pointer stayed inside the card ("demo won't turn off" report).
        this._card = new St.BoxLayout({
            style_class: 'owlpods-popup-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
        });
        this._card.set_pivot_point(0.5, 0.5);

        // Header (Title, Subtitle & Close Button)
        const headerBox = new St.BoxLayout({
            style_class: 'owlpods-card-header',
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        const titleBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._titleLabel = new St.Label({
            style_class: 'owlpods-card-title',
            text: 'AirPods Pro 3',
        });
        this._subtitleLabel = new St.Label({
            style_class: 'owlpods-card-subtitle',
            text: 'Рядом',
        });
        titleBox.add_child(this._titleLabel);
        titleBox.add_child(this._subtitleLabel);
        headerBox.add_child(titleBox);

        const closeBtn = new St.Button({
            style_class: 'owlpods-card-close-btn',
            label: '✕',
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        closeBtn.connect('clicked', () => this.dismiss());
        headerBox.add_child(closeBtn);

        this._card.add_child(headerBox);

        // Graphics and Battery Columns Container
        const devicesBox = new St.BoxLayout({
            style_class: 'owlpods-card-devices-box',
            orientation: Clutter.Orientation.HORIZONTAL,
        });

        // Left Pod Column
        const leftCol = this._createPodColumn('left', 'Левый', `${this._extensionPath}/assets/device_airpods_pro2_left.png`);
        this._leftRing = leftCol.ring;
        this._leftPctLabel = leftCol.pctLabel;
        this._leftStatusLabel = leftCol.statusLabel;

        // Case Column (Center)
        const caseCol = this._createPodColumn('case', 'Кейс', `${this._extensionPath}/assets/device_airpods_pro2_case.png`);
        this._caseRing = caseCol.ring;
        this._casePctLabel = caseCol.pctLabel;
        this._caseStatusLabel = caseCol.statusLabel;

        // Right Pod Column
        const rightCol = this._createPodColumn('right', 'Правый', `${this._extensionPath}/assets/device_airpods_pro2_right.png`);
        this._rightRing = rightCol.ring;
        this._rightPctLabel = rightCol.pctLabel;
        this._rightStatusLabel = rightCol.statusLabel;

        devicesBox.add_child(leftCol.box);
        devicesBox.add_child(caseCol.box);
        devicesBox.add_child(rightCol.box);
        this._card.add_child(devicesBox);

        // Action button (Connect if not connected)
        this._actionBox = new St.BoxLayout({
            style_class: 'owlpods-card-actions',
            x_align: Clutter.ActorAlign.CENTER,
            margin_top: 8,
        });
        this._connectBtn = new St.Button({
            style_class: 'owlpods-btn-connect',
            label: 'Подключить',
            can_focus: true,
        });
        this._connectBtn.connect('clicked', async () => {
            const svc = this._bluetoothService;
            const stateMac = this._currentState?.mac;
            // Beacon popups carry rotating RPA addresses of the unpaired LE
            // endpoint — resolve to the PAIRED set before connecting.
            const targetMac = svc?.resolveConnectTarget
                ? svc.resolveConnectTarget(stateMac)
                : stateMac;
            if (svc && targetMac) {
                this._connectBtn.label = 'Подключение...';
                this._connectBtn.reactive = false;
                const success = await svc.connectDevice(targetMac);
                if (this._destroyed) {
                    return;
                }
                this._connectBtn.reactive = true;
                this._connectBtn.label = success ? 'Подключено ✓' : 'Ошибка';
                if (success) {
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                        this.dismiss();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                // On error the card stays open so the user can retry.
            } else {
                // Demo fallback
                this._connectBtn.label = 'Подключено ✓';
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    this.dismiss();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        this._actionBox.add_child(this._connectBtn);
        this._card.add_child(this._actionBox);

        this._container.add_child(this._card);
        Main.uiGroup.add_child(this._container);
    }

    // Click-outside detection now lives entirely in the ClickGesture wiring
    // above ('may-recognize' + 'recognize'), the same shape upstream
    // PopupMenuManager uses for closing menus on outside clicks.

    _createPodColumn(type, defaultName, iconPath) {
        const col = new St.BoxLayout({
            style_class: `owlpods-device-col owlpods-col-${type}`,
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Device image
        const img = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            icon_size: type === 'case' ? 96 : 84,
            style_class: `owlpods-device-img owlpods-img-${type}`,
            x_align: Clutter.ActorAlign.CENTER,
        });
        col.add_child(img);

        // Battery Ring Container with center percentage
        const ringBox = new St.Widget({
            style_class: 'owlpods-ring-container',
            layout_manager: new Clutter.BinLayout(),
            width: 48,
            height: 48,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const ring = new BatteryRing(48, 4.5);
        const pctLabel = new St.Label({
            style_class: 'owlpods-ring-label',
            text: '--',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        ringBox.add_child(ring);
        ringBox.add_child(pctLabel);
        col.add_child(ringBox);

        // Status text (e.g. "85%", "В ухе", "⚡")
        const statusLabel = new St.Label({
            style_class: 'owlpods-col-status',
            text: defaultName,
            x_align: Clutter.ActorAlign.CENTER,
        });
        col.add_child(statusLabel);

        return { box: col, ring, pctLabel, statusLabel, img };
    }

    show(state, { replay = false } = {}) {
        // NOTE: `_titleLabel` is created by _buildCard() below, so checking it
        // here would deadlock the very first show (the card would never be
        // built at all). `_destroyed` alone guards post-disable callbacks:
        // destroy() sets it before nulling anything.
        if (this._destroyed) {
            return;
        }

        this._currentState = state;
        this._buildCard();

        console.log('[OwlPods] Popup card shown');

        const alreadyShowing = this._isShowing;

        // Update Labels & Content
        this._titleLabel.text = state.deviceName || state.modelName || 'AirPods Pro 3';
        // Real connection state: proximity beacons from nearby (not yet
        // connected) devices must not claim "Подключено".
        const isConnected = this._bluetoothService?.isConnected?.() ?? false;
        this._subtitleLabel.text = state.isPairingMode
            ? 'Режим сопряжения'
            : (isConnected ? 'Подключено' : 'Рядом');

        // Update Left Pod
        const leftBat = state.battery?.left;
        const leftChg = state.charging?.left;
        this._leftRing.setLevel(leftBat, leftChg, true);
        this._leftPctLabel.text = leftBat !== null && leftBat !== undefined ? `${leftBat}%` : '--';
        this._leftStatusLabel.text = leftChg
            ? `⚡ ${leftBat}%`
            : (state.inEar?.left ? 'В ухе' : (leftBat !== null && leftBat !== undefined ? `${leftBat}%` : '--'));

        // Update Right Pod
        const rightBat = state.battery?.right;
        const rightChg = state.charging?.right;
        this._rightRing.setLevel(rightBat, rightChg, true);
        this._rightPctLabel.text = rightBat !== null && rightBat !== undefined ? `${rightBat}%` : '--';
        this._rightStatusLabel.text = rightChg
            ? `⚡ ${rightBat}%`
            : (state.inEar?.right ? 'В ухе' : (rightBat !== null && rightBat !== undefined ? `${rightBat}%` : '--'));

        // Update Case
        const caseBat = state.battery?.case;
        const caseChg = state.charging?.case;
        this._caseRing.setLevel(caseBat, caseChg, true);
        this._casePctLabel.text = caseBat !== null && caseBat !== undefined ? `${caseBat}%` : '--';
        this._caseStatusLabel.text = caseChg ? `⚡ ${caseBat}%` : (caseBat !== null ? `${caseBat}%` : 'Кейс');

        // The card widget tree is reused across shows: clear a previous
        // session's button state ("Ошибка"/"Подключено ✓", locked clicks).
        if (this._connectBtn) {
            this._connectBtn.label = 'Подключить';
            this._connectBtn.reactive = true;
        }

        // Position Card according to style
        this._positionCard();

        // Reveal Overlay
        this._container.show();
        this._container.opacity = 255;

        if (!alreadyShowing || replay) {
            // Entrance Spring Animation (iOS/macOS Style).
            // On the actual appearance, and on an explicit `replay` request
            // (the panel menu's "Повтор анимации" action with live battery
            // data). Content refresh of an already visible card must NOT
            // replay the animation on its own.
            this._card.opacity = 0;
            this._card.scale_x = 0.82;
            this._card.scale_y = 0.82;
            this._card.translation_y = 80;

            this._card.ease({
                opacity: 255,
                scale_x: 1.0,
                scale_y: 1.0,
                translation_y: 0,
                duration: 420,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }

        this._isShowing = true;
        // Every (re)show restarts the auto-dismiss countdown.
        this._resetDismissTimer();
    }

    _positionCard() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._container.set_position(monitor.x, monitor.y);
        this._container.set_size(monitor.width, monitor.height);

        const style = this._settings.get_string('popup-style');
        // Width fits three 96 px columns + two 20 px gaps + 24 px paddings
        // plus the border; the height stays NATURAL (-1). A hardcoded height
        // (360x240) painted the frame shorter than the content: bottom labels
        // were clipped and the Connect button ended up outside the card.
        const cardWidth = 384;
        this._card.set_size(cardWidth, -1);
        const [, , , naturalHeight] = this._card.get_preferred_size();
        const cardHeight = Math.round(naturalHeight);

        if (style === 'macos') {
            // macOS style: top-right corner below panel
            const panelHeight = Main.panel.height || 36;
            this._card.set_position(
                monitor.width - cardWidth - 28,
                panelHeight + 20
            );
        } else {
            // iOS style: centered at bottom of screen
            this._card.set_position(
                Math.round((monitor.width - cardWidth) / 2),
                Math.max(12, monitor.height - cardHeight - 64)
            );
        }
    }

    dismiss() {
        if (!this._isShowing || !this._card || this._destroyed) {
            return;
        }

        this._cancelDismissTimer();
        this._isShowing = false;

        this._card.ease({
            opacity: 0,
            scale_x: 0.92,
            scale_y: 0.92,
            translation_y: 50,
            duration: 260,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                // Guard against a show() that started while this
                // dismissal was still animating (race condition).
                if (this._container && !this._isShowing) {
                    this._container.hide();
                }
            },
        });
    }

    _resetDismissTimer() {
        if (!this._isShowing) {
            return;
        }

        this._cancelDismissTimer();
        const durationSec = this._settings.get_int('popup-duration') || 5;
        this._dismissTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, durationSec, () => {
            this._dismissTimerId = 0;
            this.dismiss();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDismissTimer() {
        if (this._dismissTimerId) {
            GLib.source_remove(this._dismissTimerId);
            this._dismissTimerId = 0;
        }
    }

    destroy() {
        // Prevents any pending timers/callbacks from rebuilding the card
        // after the extension has been disabled.
        this._destroyed = true;
        this._cancelDismissTimer();
        this._bluetoothService = null;
        this._settings = null;
        this._currentState = null;
        this._isShowing = false;

        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
        this._card = null;
        this._leftRing = null;
        this._rightRing = null;
        this._caseRing = null;
    }
});
