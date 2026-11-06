import type { ESTree } from "@oxlint/plugins";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

const MAX_INFER_TYPE_PARAMETER_VISITS = 100_000;

interface LexicalTypeParameterAnalysis {
	inferNamesByExtendsType: WeakMap<ESTree.Node, ReadonlySet<string>>;
	inferTypeParameterVisits: number;
}

/** Create one analysis cache per source file. */
function createLexicalTypeParameterAnalysis(): LexicalTypeParameterAnalysis {
	return {
		inferNamesByExtendsType: new WeakMap(),
		inferTypeParameterVisits: 0,
	};
}

const analysesByProgram = new WeakMap<ESTree.Node, LexicalTypeParameterAnalysis>();

function analysisForSourceFile(node: ESTree.Node): LexicalTypeParameterAnalysis {
	let root = node;
	while (root.parent !== undefined && root.parent !== null && root.type !== "Program") {
		root = root.parent;
	}
	if (root.type !== "Program") return createLexicalTypeParameterAnalysis();
	let analysis = analysesByProgram.get(root);
	if (analysis === undefined) {
		analysis = createLexicalTypeParameterAnalysis();
		analysesByProgram.set(root, analysis);
	}
	return analysis;
}

// An exhausted scan must shadow every alias; that suppresses uncertain diagnostics.
const incompleteNames: ReadonlySet<string> = new Proxy(new Set<string>(), {
	get(target, property) {
		if (property === "has") return () => true;
		const value = Reflect.get(target, property, target);
		return typeof value === "function" ? value.bind(target) : value;
	},
});

function isNode(value: unknown): value is ESTree.Node {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

function collectInferTypeParameterNames(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
	names: Set<string>,
	analysis: LexicalTypeParameterAnalysis,
): boolean {
	if (analysis.inferTypeParameterVisits >= MAX_INFER_TYPE_PARAMETER_VISITS) return false;
	analysis.inferTypeParameterVisits += 1;
	if (node.type === "TSInferType") names.add(node.typeParameter.name.name);
	const record = node as unknown as Readonly<Record<string, unknown>>;
	for (const key of visitorKeys[node.type] ?? []) {
		const value = record[key];
		if (isNode(value)) {
			if (!collectInferTypeParameterNames(value, visitorKeys, names, analysis)) return false;
			continue;
		}
		if (!Array.isArray(value)) continue;
		for (const child of value) {
			if (isNode(child) && !collectInferTypeParameterNames(child, visitorKeys, names, analysis)) {
				return false;
			}
		}
	}
	return true;
}

/** Collect type binders that are in scope at a node and can shadow module aliases. */
export function lexicalTypeParameterNames(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
): ReadonlySet<string> {
	const fileAnalysis = analysisForSourceFile(node);
	const names = new Set<string>();
	const conditionalExtendsTypes: ESTree.Node[] = [];
	let descendant: ESTree.Node = node;
	let current: ESTree.Node | null = node;
	while (current !== null && current.type !== "Program") {
		if ("typeParameters" in current) {
			for (const parameter of current.typeParameters?.params ?? []) {
				names.add(parameter.name.name);
			}
		}
		if (
			current.type === "TSMappedType" &&
			(descendant === current.nameType || descendant === current.typeAnnotation)
		) {
			names.add(current.key.name);
		}
		if (current.type === "TSConditionalType" && descendant === current.trueType) {
			conditionalExtendsTypes.push(current.extendsType);
		}
		descendant = current;
		current = current.parent;
	}
	if (conditionalExtendsTypes.length === 0) return names;
	return new Proxy(names, {
		get(target, property) {
			if (property === "has") {
				return (name: string) => {
					if (target.has(name)) return true;
					for (const extendsType of conditionalExtendsTypes) {
						let inferredNames = fileAnalysis.inferNamesByExtendsType.get(extendsType);
						if (inferredNames === undefined) {
							const discoveredNames = new Set<string>();
							inferredNames = collectInferTypeParameterNames(
								extendsType,
								visitorKeys,
								discoveredNames,
								fileAnalysis,
							)
								? discoveredNames
								: incompleteNames;
							fileAnalysis.inferNamesByExtendsType.set(extendsType, inferredNames);
						}
						if (inferredNames === incompleteNames || inferredNames.has(name)) return true;
					}
					return false;
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
