import { expect, test } from "bun:test";

import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "./lexical-type-parameters.ts";

type Node = ESTree.Node & Record<string, unknown>;

function node(type: string, fields: Record<string, unknown> = {}): Node {
	return { type, ...fields } as Node;
}

function connect(parent: Node, child: Node, field: string): void {
	parent[field] = child;
	child.parent = parent;
}

function fixture(callbackCount: number, unionSize: number, inferredNames?: readonly string[]) {
	const program = node("Program", {});
	const conditional = node("TSConditionalType", {});
	const inferred = Array.from({ length: unionSize }, (_, index) => {
		const infer = node("TSInferType", {});
		infer.typeParameter = { name: { name: inferredNames?.[index] ?? `T${index}` } };
		return infer;
	});
	const extendsType = node("TSUnionType", { types: inferred });
	const trueType = node("TSUnionType", { types: [] });
	connect(program, conditional, "declaration");
	connect(conditional, extendsType, "extendsType");
	connect(conditional, trueType, "trueType");

	const callbacks = Array.from({ length: callbackCount }, (_, index) => {
		const callback = node("TSFunctionType", {});
		connect(trueType, callback, `callback${index}`);
		return callback;
	});
	const visitorKeys = new Proxy(
		{
			TSConditionalType: ["extendsType", "trueType"],
			TSUnionType: ["types"],
			TSInferType: [],
			TSFunctionType: [],
			Program: ["declaration"],
		},
		{ get(target, key: string) {
			return Reflect.get(target, key);
		} },
	);
	return { callbacks, visitorKeys };
}

test("reuses inferred names for many callbacks under one conditional type", () => {
	const { callbacks, visitorKeys } = fixture(24, 24);
	let visited = 0;
	const countedKeys = new Proxy(visitorKeys, {
		get(target, key: string) {
			if (key !== "then") visited += 1;
			return Reflect.get(target, key);
		},
	});

	for (const callback of callbacks) {
		const names = lexicalTypeParameterNames(callback, countedKeys);
		expect(names.has("T0")).toBe(true);
	}

	expect(visited, "one extends subtree should be analyzed once per source file").toBe(25);
});

test("defers binder discovery until a caller checks an alias name", () => {
	const { callbacks, visitorKeys } = fixture(1, 2);
	let visited = 0;
	const countedKeys = new Proxy(visitorKeys, {
		get(target, key: string) {
			if (key !== "then") visited += 1;
			return Reflect.get(target, key);
		},
	});

	const names = lexicalTypeParameterNames(callbacks[0]!, countedKeys);
	expect(visited, "a parameter-free callback should not discover binders").toBe(0);
	expect(names.has("T0")).toBe(true);
	expect(visited).toBe(3);
});

test("inferred binders shadow module aliases", () => {
	const { callbacks, visitorKeys } = fixture(1, 1, ["ModuleAlias"]);
	const names = lexicalTypeParameterNames(callbacks[0]!, visitorKeys);

	expect(names.has("ModuleAlias"), "the extends infer binder shadows the module alias").toBe(true);
});

test("keeps inferred binders local to each source file", () => {
	const firstFile = fixture(1, 3);
	const secondFile = fixture(1, 3);
	let firstVisits = 0;
	let secondVisits = 0;
	const firstKeys = new Proxy(firstFile.visitorKeys, {
		get(target, key: string) {
			if (key !== "then") firstVisits += 1;
			return Reflect.get(target, key);
		},
	});
	const secondKeys = new Proxy(secondFile.visitorKeys, {
		get(target, key: string) {
			if (key !== "then") secondVisits += 1;
			return Reflect.get(target, key);
		},
	});

	const first = lexicalTypeParameterNames(firstFile.callbacks[0]!, firstKeys);
	const second = lexicalTypeParameterNames(secondFile.callbacks[0]!, secondKeys);

	expect(first.has("T0")).toBe(true);
	expect(second.has("T2")).toBe(true);
	expect(firstVisits).toBe(4);
	expect(secondVisits).toBe(4);
});

test("treats inferred names as shadowing when the work limit is exhausted", () => {
	const { callbacks, visitorKeys } = fixture(24, 100_001);
	let visited = 0;
	const countedKeys = new Proxy(visitorKeys, {
		get(target, key: string) {
			if (key !== "then") visited += 1;
			return Reflect.get(target, key);
		},
	});
	for (const callback of callbacks) {
		const names = lexicalTypeParameterNames(callback, countedKeys);
		expect(names.has("ModuleAlias"), "incomplete binder scans must suppress alias diagnostics").toBe(true);
	}
	expect(visited, "the per-file work cap must stop traversal").toBe(100_000);
});
