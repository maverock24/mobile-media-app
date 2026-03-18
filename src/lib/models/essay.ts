/**
 * Audio Essay Player Data Models
 */

export interface EssayMetadata {
	id: string;
	title: string;
	description: string;
	author: string;
	topic: string;
	audioUrl: string;
	duration: number; // in seconds
	fileSize: number; // in MB
	thumbnail?: string;
	publishedDate: string;
	transcriptUrl?: string;
	tags: string[];
}

export interface EssayLibrary {
	essays: EssayMetadata[];
	lastUpdated: string;
	version: string;
}
