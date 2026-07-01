import { registerPlugin } from '@capacitor/core';

export interface ScreenDimPlugin {
	enable(options: { delayMs: number }): Promise<void>;
	disable(): Promise<void>;
	isEnabled(): Promise<{ enabled: boolean }>;
}

export const ScreenDim = registerPlugin<ScreenDimPlugin>('ScreenDim');
