export type ListTileTone = 'default' | 'slate' | 'cyan' | 'emerald' | 'amber';

export const LIST_TILE_TONE_OPTIONS = [
	{ id: 'default', label: 'Default', description: 'Standard accent hover state' },
	{ id: 'slate', label: 'Slate', description: 'Cool neutral tint' },
	{ id: 'cyan', label: 'Cyan', description: 'Bright blue-teal tint' },
	{ id: 'emerald', label: 'Emerald', description: 'Fresh green tint' },
	{ id: 'amber', label: 'Amber', description: 'Warm golden tint' },
] as const satisfies ReadonlyArray<{
	id: ListTileTone;
	label: string;
	description: string;
}>;

export function normalizeListTileTone(value: unknown): ListTileTone {
	if (value === 'lighter') return 'slate';
	if (value === 'default' || value === 'slate' || value === 'cyan' || value === 'emerald' || value === 'amber') {
		return value;
	}
	return 'default';
}

export function getListTileToneClasses(tone: ListTileTone): { rowClass: string; actionClass: string; usesTint: boolean } {
	if (tone === 'default') {
		return { rowClass: '', actionClass: '', usesTint: false };
	}

	return {
		rowClass: `list-tile-tone-${tone}-row`,
		actionClass: `list-tile-tone-${tone}-action`,
		usesTint: true,
	};
}