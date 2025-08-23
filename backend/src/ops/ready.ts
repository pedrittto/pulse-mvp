export type ReadyState = { firestore: boolean; scheduler: boolean; sse: boolean; warmupDone?: boolean };

const state: ReadyState = { firestore: false, scheduler: false, sse: false, warmupDone: false };

export function setReady(part: keyof ReadyState, value: boolean) {
	(state as any)[part] = !!value;
}

export function getReady(): ReadyState {
	return { ...state };
}

export function isReady(): boolean {
	const s = state;
	const warmupNeeded = process.env.WARMUP_TIER1 === '1';
	return !!(s.firestore && s.scheduler && s.sse && (!warmupNeeded || s.warmupDone));
}


