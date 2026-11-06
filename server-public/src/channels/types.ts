// Client-neutral boundary. Telegram deliberately keeps its existing numeric message handles.
export type ClientChannel = "telegram" | "weixin";

export interface ChatTransport {
	readonly channel?: ClientChannel;
	readonly supportsEdits?: boolean;
	readonly messageLimit?: number;
	send(chatId: string, text: string, opts?: { silent?: boolean }): Promise<number>;
	edit(chatId: string, messageId: number, text: string): Promise<void>;
	remove(chatId: string, messageId: number): Promise<void>;
	typing(chatId: string): Promise<void>;
	sendFile(chatId: string, path: string, caption?: string): Promise<void>;
	download(fileId: string, dest: string): Promise<void>;
}

export interface NotificationOptions {
	silent?: boolean;
	file?: string;
	caption?: string;
	source?: string;
	via?: "pool" | ClientChannel;
	/** Explicit Telegram recipient, or the bound Weixin owner when via=weixin. */
	chat?: string;
}

export interface NotificationSink {
	notify(text: string, options?: NotificationOptions): Promise<void>;
	status(): string;
	setBroadcast(enabled: boolean): void;
	touch(channel: ClientChannel, at?: Date): void;
	retryPending(): Promise<void>;
}
