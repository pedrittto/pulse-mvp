export type SocialPost = {
	id: string;
	text: string;
	author?: string;
	created_at: string;
	url?: string;
};

export interface SocialProvider {
	pollRecent(): Promise<SocialPost[]>; // returns posts newer than internal cursor
}


