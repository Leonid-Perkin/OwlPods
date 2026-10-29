// src/proximityParser.js
// Decoder for Apple Bluetooth Low Energy Continuity Proximity Pairing messages.

import { getModelInfo } from './models.js';

export const APPLE_COMPANY_ID = 0x004C;
export const CONTINUITY_TYPE_PROXIMITY_PAIRING = 0x07;

export class ProximityParser {
    /**
     * Parses an Apple BLE Proximity Pairing manufacturer data payload.
     * @param {Uint8Array|Array<number>} bytes
     * @returns {object|null} Decoded AirPods state or null if not valid
     */
    static parse(bytes) {
        if (!bytes || bytes.length < 8) {
            return null;
        }

        // Sometimes the BlueZ payload starts directly with message type (0x07),
        // or has a length header. Let's find type 0x07.
        let offset = 0;
        if (bytes[0] !== CONTINUITY_TYPE_PROXIMITY_PAIRING) {
            if (bytes[1] === CONTINUITY_TYPE_PROXIMITY_PAIRING) {
                offset = 1;
            } else {
                return null;
            }
        }

        const type = bytes[offset];
        if (type !== CONTINUITY_TYPE_PROXIMITY_PAIRING) {
            return null;
        }

        const remaining = bytes.slice(offset);
        if (remaining.length < 9) {
            return null;
        }

        // remaining[0] = 0x07 (Type)
        // remaining[1] = Length (usually 0x19 = 25)
        // remaining[2] = Prefix (0x01 = normal status, 0x00 = pairing mode)
        const prefix = remaining[2];
        const isPairingMode = prefix === 0x00;

        // Model ID (Big Endian)
        const modelId = ((remaining[3] & 0xFF) << 8) | (remaining[4] & 0xFF);
        const modelInfo = getModelInfo(modelId);

        // Status byte
        const status = remaining[5];
        const primaryLeft = (status & 0x20) !== 0; // Bit 5: 1 = Left, 0 = Right
        const areValuesFlipped = !primaryLeft;

        const isThisPodInCase = (status & 0x40) !== 0; // Bit 6
        const isOnePodInCase = (status & 0x10) !== 0;  // Bit 4
        const areBothPodsInCase = (status & 0x04) !== 0; // Bit 2

        // Ear detection with XOR factor
        const xorFactor = (areValuesFlipped ? 1 : 0) ^ (isThisPodInCase ? 1 : 0);
        const isLeftInEar = xorFactor ? ((status & 0x08) !== 0) : ((status & 0x02) !== 0);
        const isRightInEar = xorFactor ? ((status & 0x02) !== 0) : ((status & 0x08) !== 0);

        // Battery bytes
        const podsBattery = remaining[6];
        const lowerNibble = podsBattery & 0x0F;
        const upperNibble = (podsBattery >> 4) & 0x0F;

        const leftNibble = areValuesFlipped ? upperNibble : lowerNibble;
        const rightNibble = areValuesFlipped ? lowerNibble : upperNibble;

        const leftBattery = leftNibble === 15 ? null : (leftNibble > 10 ? 100 : leftNibble * 10);
        const rightBattery = rightNibble === 15 ? null : (rightNibble > 10 ? 100 : rightNibble * 10);

        // Case battery and charging flags
        const flagsAndCase = remaining[7];
        const caseNibble = flagsAndCase & 0x0F;
        const caseBattery = caseNibble === 15 ? null : (caseNibble > 10 ? 100 : caseNibble * 10);

        const flags = (flagsAndCase >> 4) & 0x0F;
        const isCaseCharging = (flags & 0x04) !== 0; // Bit 2
        const isLeftCharging = areValuesFlipped ? ((flags & 0x02) !== 0) : ((flags & 0x01) !== 0);
        const isRightCharging = areValuesFlipped ? ((flags & 0x01) !== 0) : ((flags & 0x02) !== 0);

        // Lid state
        const lidIndicator = remaining[8];
        // Lid is open if pod is communicating from inside case, or both are in case,
        // or bit 0 of lid byte is asserted.
        const isLidOpen = isThisPodInCase || areBothPodsInCase || ((lidIndicator & 0x01) !== 0);

        // Optional Color
        const colorId = remaining.length > 9 ? remaining[9] : 0;

        return {
            modelId,
            modelName: modelInfo.name,
            modelInfo,
            isPairingMode,
            primaryPod: primaryLeft ? 'LEFT' : 'RIGHT',
            battery: {
                left: leftBattery,
                right: rightBattery,
                case: caseBattery,
            },
            charging: {
                left: isLeftCharging,
                right: isRightCharging,
                case: isCaseCharging,
            },
            inEar: {
                left: isLeftInEar,
                right: isRightInEar,
            },
            caseState: {
                isThisPodInCase,
                isOnePodInCase,
                areBothPodsInCase,
                isLidOpen,
                lidIndicator,
            },
            colorId,
            timestamp: Date.now(),
        };
    }

    /**
     * Generates a realistic mock BLE byte array for AirPods Pro 3.
     */
    static createMockPacket({
        modelId = 0x2720, // AirPods Pro 3
        leftBattery = 85,
        rightBattery = 90,
        caseBattery = 65,
        isLeftCharging = false,
        isRightCharging = false,
        isCaseCharging = true,
        isLeftInEar = false,
        isRightInEar = false,
        isLidOpen = true,
    } = {}) {
        const bytes = new Uint8Array(27);
        bytes[0] = CONTINUITY_TYPE_PROXIMITY_PAIRING; // 0x07
        bytes[1] = 0x19; // Length: 25 bytes
        bytes[2] = 0x01; // Prefix: normal status broadcast

        // Model ID (Big-Endian)
        bytes[3] = (modelId >> 8) & 0xFF;
        bytes[4] = modelId & 0xFF;

        // Status byte (data[5])
        // Bit 5 = primary Left (1)
        // Bit 6 = isThisPodInCase
        // Bit 2 = areBothPodsInCase
        let status = 0x20; // Left is primary
        if (isLidOpen) {
            status |= 0x40; // In case
            status |= 0x04; // Both in case
        }
        if (isLeftInEar) status |= 0x02;
        if (isRightInEar) status |= 0x08;
        bytes[5] = status;

        // Battery byte (data[6])
        const leftNibble = Math.min(10, Math.max(0, Math.round(leftBattery / 10)));
        const rightNibble = Math.min(10, Math.max(0, Math.round(rightBattery / 10)));
        // Left is primary -> lowerNibble = left, upperNibble = right
        bytes[6] = (rightNibble << 4) | (leftNibble & 0x0F);

        // Flags & Case battery (data[7])
        const caseNibble = Math.min(10, Math.max(0, Math.round(caseBattery / 10)));
        let flags = 0;
        if (isLeftCharging) flags |= 0x01;
        if (isRightCharging) flags |= 0x02;
        if (isCaseCharging) flags |= 0x04;
        bytes[7] = (flags << 4) | (caseNibble & 0x0F);

        // Lid byte
        bytes[8] = isLidOpen ? 0x01 : 0x00;
        bytes[9] = 0x00; // White color

        return bytes;
    }
}
