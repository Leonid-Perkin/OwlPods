// src/animatedBatteryRing.js
// Custom circular battery ring with Cairo drawing and smooth fill animation.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const BatteryRing = GObject.registerClass({
    GTypeName: 'OwlPodsBatteryRing',
}, class BatteryRing extends St.DrawingArea {
    _init(size = 48, strokeWidth = 4.5) {
        super._init({
            width: size,
            height: size,
            style_class: 'owlpods-battery-ring-area',
        });

        this._size = size;
        this._strokeWidth = strokeWidth;
        this._currentPercentage = 0;
        this._targetPercentage = 0;
        this._isCharging = false;
        this._animTimerId = 0;

        this.connect('repaint', this._onRepaint.bind(this));
    }

    setLevel(percentage, isCharging = false, animate = true) {
        this._isCharging = isCharging;
        const target = percentage === null ? 0 : Math.max(0, Math.min(100, percentage));
        this._targetPercentage = target;

        if (!animate) {
            this._currentPercentage = target;
            this.queue_repaint();
            return;
        }

        if (this._animTimerId) {
            GLib.source_remove(this._animTimerId);
            this._animTimerId = 0;
        }

        const start = this._currentPercentage;
        const diff = target - start;
        const durationMs = 450;
        const startTime = GLib.get_monotonic_time();

        this._animTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const now = GLib.get_monotonic_time();
            const elapsed = (now - startTime) / 1000;
            const progress = Math.min(1.0, elapsed / durationMs);

            // Easing: ease-out cubic
            const ease = 1 - Math.pow(1 - progress, 3);
            this._currentPercentage = start + diff * ease;
            this.queue_repaint();

            if (progress >= 1.0) {
                this._currentPercentage = target;
                this.queue_repaint();
                this._animTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onRepaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(w, h) / 2 - this._strokeWidth;

        // Background track
        cr.setLineWidth(this._strokeWidth);
        cr.setLineCap(1); // ROUND
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.15);
        cr.stroke();

        if (this._currentPercentage <= 0) {
            cr.$dispose();
            return;
        }

        // Color based on level and charging state
        let r, g, b;
        if (this._isCharging) {
            // Charging green
            r = 0.20; g = 0.85; b = 0.40;
        } else if (this._currentPercentage <= 10) {
            // Critical red
            r = 1.00; g = 0.23; b = 0.19;
        } else if (this._currentPercentage <= 20) {
            // Low yellow/amber
            r = 1.00; g = 0.65; b = 0.00;
        } else {
            // Healthy Apple Green
            r = 0.20; g = 0.80; b = 0.35;
        }

        const startAngle = -Math.PI / 2;
        const sweepAngle = (this._currentPercentage / 100) * 2 * Math.PI;

        cr.setLineWidth(this._strokeWidth);
        cr.setLineCap(1); // ROUND
        cr.arc(cx, cy, radius, startAngle, startAngle + sweepAngle);
        cr.setSourceRGBA(r, g, b, 1.0);
        cr.stroke();

        cr.$dispose();
    }

    destroy() {
        if (this._animTimerId) {
            GLib.source_remove(this._animTimerId);
            this._animTimerId = 0;
        }
        super.destroy();
    }
});
