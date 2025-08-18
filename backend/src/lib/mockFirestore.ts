// Minimal in-memory Firestore mock for local/dev use only
// Guarded by env USE_FAKE_FIRESTORE=1 in lib/firestore.ts

type DocData = Record<string, any>;

class MockDocSnapshot {
	constructor(public id: string, private _data: DocData | undefined) {}
	get exists(): boolean { return !!this._data; }
	data(): DocData { return this._data ? { ...this._data } : ({} as any); }
}

class MockQuerySnapshot {
	constructor(public docs: Array<{ id: string; data: () => DocData }>) {}
	get size(): number { return this.docs.length; }
	forEach(cb: (doc: { id: string; data: () => DocData }) => void): void { this.docs.forEach(d => cb(d)); }
}

class MockWriteBatch {
	private ops: Array<() => void> = [];
	set(ref: MockDocumentReference, data: DocData, options?: { merge?: boolean }) {
		this.ops.push(() => ref._set(data, options));
		return this;
	}
	delete(ref: MockDocumentReference) {
		this.ops.push(() => ref._delete());
		return this;
	}
	async commit(): Promise<void> { this.ops.forEach(op => op()); this.ops = []; }
}

class MockDocumentReference {
	constructor(private col: MockCollectionReference, public id: string) {}
	async get(): Promise<MockDocSnapshot> { return new MockDocSnapshot(this.id, this.col._get(this.id)); }
	async set(data: DocData, options?: { merge?: boolean }): Promise<void> { this._set(data, options); }
	_set(data: DocData, options?: { merge?: boolean }): void {
		const prev = this.col._get(this.id) || {};
		this.col._set(this.id, options?.merge ? { ...prev, ...data } : { ...data });
	}
	async update(data: DocData): Promise<void> { this._set({ ...(this.col._get(this.id) || {}), ...data }); }
	_delete(): void { this.col._delete(this.id); }
}

class MockQuery {
	constructor(private col: MockCollectionReference, private filters: Array<[string, string, any]> = [], private order?: [string, 'asc' | 'desc'], private _limit?: number) {}
	where(field: string, op: '==' | '>=' | '<=' | '<' | '>', value: any) {
		return new MockQuery(this.col, [...this.filters, [field, op, value]], this.order, this._limit);
	}
	orderBy(field: string, dir: 'asc' | 'desc' = 'asc') { return new MockQuery(this.col, this.filters, [field, dir], this._limit); }
	limit(n: number) { return new MockQuery(this.col, this.filters, this.order, n); }
	async get(): Promise<MockQuerySnapshot> {
		let records = this.col._all();
		// apply filters
		for (const [field, op, value] of this.filters) {
			records = records.filter(([_, data]) => {
				const v = data[field];
				if (op === '==') return v === value;
				if (op === '>=') return v >= value;
				if (op === '<=') return v <= value;
				if (op === '<') return v < value;
				if (op === '>') return v > value;
				return false;
			});
		}
		// apply order
		if (this.order) {
			const [field, dir] = this.order;
			records.sort((a, b) => {
				const av = a[1][field];
				const bv = b[1][field];
				if (av === bv) return 0;
				return (av > bv ? 1 : -1) * (dir === 'asc' ? 1 : -1);
			});
		}
		// apply limit
		if (typeof this._limit === 'number') {
			records = records.slice(0, this._limit);
		}
		const docs = records.map(([id, data]) => ({ id, data: () => ({ ...data }) }));
		return new MockQuerySnapshot(docs);
	}
}

class MockCount {
	constructor(private col: MockCollectionReference) {}
	async get(): Promise<{ data: () => { count: number } }> {
		return { data: () => ({ count: this.col._all().length }) } as any;
	}
}

class MockCollectionReference {
	constructor(private store: Map<string, DocData>, public collectionPath: string) {}
	doc(id: string): MockDocumentReference { return new MockDocumentReference(this, id); }
	async add(data: DocData): Promise<MockDocumentReference> {
		const id = Math.random().toString(36).slice(2, 10);
		this._set(id, data);
		return this.doc(id);
	}
	orderBy(field: string, dir: 'asc' | 'desc' = 'asc') { return new MockQuery(this, [], [field, dir]); }
	limit(n: number) { return new MockQuery(this, [], undefined, n); }
	where(field: string, op: any, value: any) { return new MockQuery(this, [[field, op, value]]); }
	async get(): Promise<MockQuerySnapshot> { return new MockQuery(this).get(); }
	count(): MockCount { return new MockCount(this); }
	// internal helpers
	_get(id: string): DocData | undefined { return this.store.get(id); }
	_set(id: string, data: DocData): void { this.store.set(id, { ...data }); }
	_delete(id: string): void { this.store.delete(id); }
	_all(): Array<[string, DocData]> { return Array.from(this.store.entries()); }
}

export class MockFirestore {
	private collections: Map<string, Map<string, DocData>> = new Map();
	collection(name: string): MockCollectionReference {
		if (!this.collections.has(name)) this.collections.set(name, new Map());
		return new MockCollectionReference(this.collections.get(name)!, name);
	}
	batch(): MockWriteBatch { return new MockWriteBatch(); }
	async listCollections(): Promise<Array<{ id: string }>> { return Array.from(this.collections.keys()).map(id => ({ id })); }
	settings(_opts: any) { /* no-op */ }
}

export function createMockDb(): any {
	return new MockFirestore() as any;
}


