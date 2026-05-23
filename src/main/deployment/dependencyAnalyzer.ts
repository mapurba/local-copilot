/**
 * Dependency Analyzer
 *
 * Builds a dependency graph from a list of ServiceSpec objects, performs
 * cycle detection, topological sort, and level assignment for parallel
 * deployment.
 */

import { ServiceSpec, DependencyEdge, DependencyGraph } from './types';

/**
 * Build a full dependency graph from a service list.
 * Handles cycle detection, topological sort, and level assignment.
 */
export function buildDependencyGraph(services: ServiceSpec[]): DependencyGraph {
  const warnings: string[] = [];
  const serviceIds = services.map((s) => s.id);

  // Build adjacency list: from → [to] (from depends on to)
  const adjacency = new Map<string, Set<string>>();
  for (const s of services) {
    adjacency.set(s.id, new Set(s.requiresConfigFrom.filter((id) => serviceIds.includes(id))));
  }

  // ── Cycle detection (DFS) ─────────────────────────────────────────────────
  const WHITE = 0; // unvisited
  const GRAY = 1;  // in current DFS stack
  const BLACK = 2; // fully processed
  const color = new Map<string, number>(serviceIds.map((id) => [id, WHITE]));
  const cycleEdgesToRemove: Array<[string, string]> = [];

  function dfs(node: string, path: string[]): void {
    color.set(node, GRAY);
    path.push(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      if (color.get(neighbor) === GRAY) {
        // Found a cycle — remove the longest back-edge to break it
        const cycleStart = path.indexOf(neighbor);
        const cycleNodes = path.slice(cycleStart);
        // The longest edge creating the cycle is node→neighbor (the back-edge itself)
        cycleEdgesToRemove.push([node, neighbor]);
        warnings.push(
          `Cycle detected: ${[...cycleNodes, neighbor].join(' → ')}. Removing edge ${node}→${neighbor}.`
        );
      } else if (color.get(neighbor) === WHITE) {
        dfs(neighbor, path);
      }
    }
    path.pop();
    color.set(node, BLACK);
  }

  for (const id of serviceIds) {
    if (color.get(id) === WHITE) {
      dfs(id, []);
    }
  }

  // Remove cycle-breaking edges
  for (const [from, to] of cycleEdgesToRemove) {
    adjacency.get(from)?.delete(to);
  }

  // ── Build DependencyEdge list ─────────────────────────────────────────────
  const serviceMap = new Map(services.map((s) => [s.id, s]));
  const edges: DependencyEdge[] = [];
  for (const [fromId, deps] of adjacency.entries()) {
    const fromService = serviceMap.get(fromId);
    for (const toId of deps) {
      const toService = serviceMap.get(toId);
      // Config keys that flow from toService to fromService
      const relevantKeys = (fromService?.requiresConfigFrom ?? []).includes(toId)
        ? (toService?.configKeys ?? []).map((k) => k.key)
        : [];
      edges.push({ from: fromId, to: toId, configKeys: relevantKeys });
    }
  }

  // ── Kahn's algorithm for topological sort ─────────────────────────────────
  // inDegree: number of services that 'node' depends on (i.e., edges pointing INTO node)
  const inDegree = new Map<string, number>(serviceIds.map((id) => [id, 0]));
  for (const [, deps] of adjacency.entries()) {
    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
    }
  }

  // Reverse adjacency: who depends on me?
  const reverseAdj = new Map<string, Set<string>>();
  for (const id of serviceIds) reverseAdj.set(id, new Set());
  for (const [from, deps] of adjacency.entries()) {
    for (const to of deps) {
      reverseAdj.get(to)!.add(from);
    }
  }

  // Queue starts with nodes nothing depends on (leaf nodes / no dependents)
  // Actually for deployment order we want leaf-first:
  //   "leaf" = a service that no other service requires (inDegree in reverse = 0, i.e. outDegree in original = 0)
  // We process nodes with outDegree 0 first (true leaves), building bottom-up.
  const outDegree = new Map<string, number>(serviceIds.map((id) => [id, adjacency.get(id)?.size ?? 0]));
  
  // Use in-degree on the REVERSE graph (= out-degree on original) for leaf-first Kahn's
  const queue: string[] = [];
  for (const id of serviceIds) {
    if ((outDegree.get(id) ?? 0) === 0) queue.push(id);
  }
  
  const deploymentOrder: string[] = [];
  const remaining = new Set(serviceIds);

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!remaining.has(node)) continue;
    remaining.delete(node);
    deploymentOrder.push(node);
    // After we deploy 'node', dependents that required it can now run if all their deps are done
    for (const dependent of reverseAdj.get(node) ?? []) {
      if (!remaining.has(dependent)) continue;
      const deps = adjacency.get(dependent) ?? new Set();
      const stillWaiting = [...deps].filter((d) => remaining.has(d));
      if (stillWaiting.length === 0) {
        queue.push(dependent);
      }
    }
  }

  // Any nodes not yet added (shouldn't happen after cycle removal, but be safe)
  for (const id of remaining) {
    deploymentOrder.push(id);
    warnings.push(`Service '${id}' could not be topologically sorted — appended at end.`);
  }

  const teardownOrder = [...deploymentOrder].reverse();

  // ── Level assignment (BFS from leaves) ───────────────────────────────────
  // Level 0 = deepest leaves (no dependencies), deployed first
  const level = new Map<string, number>(serviceIds.map((id) => [id, 0]));
  for (const node of deploymentOrder) {
    for (const dep of adjacency.get(node) ?? []) {
      // node depends on dep → node must be at least level(dep)+1
      if ((level.get(node) ?? 0) <= (level.get(dep) ?? 0)) {
        level.set(node, (level.get(dep) ?? 0) + 1);
      }
    }
  }

  const maxLevel = Math.max(0, ...Array.from(level.values()));
  const levels: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const [id, lvl] of level.entries()) {
    levels[lvl].push(id);
  }

  return {
    nodes: serviceIds,
    edges,
    deploymentOrder,
    teardownOrder,
    levels,
  };
}
