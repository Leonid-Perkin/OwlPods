// src/models.js
// AirPods device definitions based on CAPod and LibrePods reverse engineering

export const PodModelId = {
    AIRPODS_GEN1: 0x0220,
    AIRPODS_GEN2: 0x0F20,
    AIRPODS_GEN3: 0x1320,
    AIRPODS_GEN4: 0x1920,
    AIRPODS_GEN4_ANC: 0x1B20,
    AIRPODS_PRO1: 0x0E20,
    AIRPODS_PRO2_LIGHTNING: 0x1420,
    AIRPODS_PRO2_USBC: 0x2420,
    AIRPODS_PRO3: 0x2720,
    AIRPODS_MAX_LIGHTNING: 0x0A20,
    AIRPODS_MAX_USBC: 0x1F20,
};

export const POD_MODELS = {
    [PodModelId.AIRPODS_PRO3]: {
        id: PodModelId.AIRPODS_PRO3,
        name: 'AirPods Pro 3',
        hasAnc: true,
        hasAdaptiveAnc: true,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_PRO2_USBC]: {
        id: PodModelId.AIRPODS_PRO2_USBC,
        name: 'AirPods Pro 2 (USB-C)',
        hasAnc: true,
        hasAdaptiveAnc: true,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_PRO2_LIGHTNING]: {
        id: PodModelId.AIRPODS_PRO2_LIGHTNING,
        name: 'AirPods Pro 2',
        hasAnc: true,
        hasAdaptiveAnc: true,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_PRO1]: {
        id: PodModelId.AIRPODS_PRO1,
        name: 'AirPods Pro',
        hasAnc: true,
        hasAdaptiveAnc: false,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_GEN4_ANC]: {
        id: PodModelId.AIRPODS_GEN4_ANC,
        name: 'AirPods 4 with ANC',
        hasAnc: true,
        hasAdaptiveAnc: true,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_GEN4]: {
        id: PodModelId.AIRPODS_GEN4,
        name: 'AirPods 4',
        hasAnc: false,
        hasAdaptiveAnc: false,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_GEN3]: {
        id: PodModelId.AIRPODS_GEN3,
        name: 'AirPods (3rd gen)',
        hasAnc: false,
        hasAdaptiveAnc: false,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_GEN2]: {
        id: PodModelId.AIRPODS_GEN2,
        name: 'AirPods (2nd gen)',
        hasAnc: false,
        hasAdaptiveAnc: false,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_GEN1]: {
        id: PodModelId.AIRPODS_GEN1,
        name: 'AirPods (1st gen)',
        hasAnc: false,
        hasAdaptiveAnc: false,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_MAX_USBC]: {
        id: PodModelId.AIRPODS_MAX_USBC,
        name: 'AirPods Max (USB-C)',
        hasAnc: true,
        hasAdaptiveAnc: false,
        hasCase: false,
        isDualPods: false,
        assetPrefix: 'device_airpods_pro2',
    },
    [PodModelId.AIRPODS_MAX_LIGHTNING]: {
        id: PodModelId.AIRPODS_MAX_LIGHTNING,
        name: 'AirPods Max',
        hasAnc: true,
        hasAdaptiveAnc: false,
        hasCase: false,
        isDualPods: false,
        assetPrefix: 'device_airpods_pro2',
    },
};

export function getModelInfo(modelId) {
    if (POD_MODELS[modelId]) {
        return POD_MODELS[modelId];
    }
    // Default fallback to AirPods Pro style if unrecognized Apple pod
    return {
        id: modelId,
        name: 'AirPods Pro',
        hasAnc: true,
        hasAdaptiveAnc: true,
        hasCase: true,
        isDualPods: true,
        assetPrefix: 'device_airpods_pro2',
    };
}
