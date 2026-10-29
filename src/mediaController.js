// src/mediaController.js
// Handles automatic pause/resume of media playback when AirPods are removed/inserted.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export const MediaController = GObject.registerClass({
    GTypeName: 'OwlPodsMediaController',
}, class MediaController extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._dbusConnection = null;
        this._lastLeftInEar = null;
        this._lastRightInEar = null;
        this._wasPausedByEarDetection = false;
        this._destroyed = false;

        this._initDBus();
    }

    _initDBus() {
        // g_bus_get() has no Promise-based wrapper in GJS 1.90 ("At least 3
        // arguments required"), so the synchronous variant is used explicitly.
        try {
            this._dbusConnection = Gio.bus_get_sync(
                Gio.BusType.SESSION,
                this._cancellable
            );
        } catch (e) {
            console.error(`[OwlPods] MediaController DBus init error: ${e.message}`);
        }
    }

    /**
     * Processes ear detection state change.
     */
    handleEarState(inEarState) {
        if (this._destroyed || !this._settings.get_boolean('ear-detection-pause')) {
            return;
        }

        const left = inEarState.left;
        const right = inEarState.right;

        // First initialization
        if (this._lastLeftInEar === null || this._lastRightInEar === null) {
            this._lastLeftInEar = left;
            this._lastRightInEar = right;
            return;
        }

        // Earbud removed: was in ear, now out
        const leftRemoved = this._lastLeftInEar === true && left === false;
        const rightRemoved = this._lastRightInEar === true && right === false;

        // Earbud inserted: was out, now in
        const leftInserted = this._lastLeftInEar === false && left === true;
        const rightInserted = this._lastRightInEar === false && right === true;

        this._lastLeftInEar = left;
        this._lastRightInEar = right;

        if (leftRemoved || rightRemoved) {
            this._pausePlayback();
        } else if (leftInserted || rightInserted) {
            if (this._wasPausedByEarDetection) {
                this._resumePlayback();
            }
        }
    }

    async _pausePlayback() {
        const player = await this._getActivePlayer();
        if (player) {
            try {
                await this._dbusConnection.call(
                    player,
                    '/org/mpris/MediaPlayer2',
                    'org.mpris.MediaPlayer2.Player',
                    'Pause',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    this._cancellable
                );
                this._wasPausedByEarDetection = true;
            } catch (e) {
                // Player might not support Pause or already stopped
            }
        }
    }

    async _resumePlayback() {
        const player = await this._getActivePlayer();
        if (player) {
            try {
                await this._dbusConnection.call(
                    player,
                    '/org/mpris/MediaPlayer2',
                    'org.mpris.MediaPlayer2.Player',
                    'Play',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    this._cancellable
                );
                this._wasPausedByEarDetection = false;
            } catch (e) {
                // Player might not support Play
            }
        }
    }

    async _getActivePlayer() {
        if (!this._dbusConnection) return null;
        try {
            const reply = await this._dbusConnection.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null,
                new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable
            );

            const [names] = reply.deepUnpack();
            const players = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
            return players.length > 0 ? players[0] : null;
        } catch (e) {
            return null;
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._settings = null;
    }
});
