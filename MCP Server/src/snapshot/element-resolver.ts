/**
 * Stable element reference management.
 *
 * Implements Fix 4: stable element references across snapshots.
 * The key insight is that `backendNodeId` from CDP is stable within a page
 * lifecycle. The problem in the monolith was that the uid assignment layer
 * cleared on every new snapshot, making old refs invalid.
 *
 * This resolver maintains cumulative maps that persist across snapshots
 * within the same page, only clearing on navigation.
 */

import type { AXNode } from './accessibility.js';

export class ElementResolver {
  /** uid → backendNodeId (cumulative across snapshots) */
  private uidToBackendId = new Map<number, number>();
  /** backendNodeId → uid (reverse lookup for reuse) */
  private backendIdToUid = new Map<number, number>();
  /** Next uid to assign (monotonically increasing) */
  private nextUid = 1;

  /**
   * Assign stable uids to AX nodes.
   *
   * For nodes with a `backendNodeId` already seen in a prior snapshot,
   * the same uid is reused — this means old refs remain valid even after
   * taking a new snapshot, as long as the DOM element still exists.
   *
   * New elements get fresh uids that don't collide with prior assignments.
   */
  assignRefs(nodes: AXNode[]): void {
    this.walkAndAssign(nodes);
  }

  private walkAndAssign(nodes: AXNode[]): void {
    for (const node of nodes) {
      const backendId = node.backendNodeId;
      if (backendId) {
        const existingUid = this.backendIdToUid.get(backendId);
        if (existingUid !== undefined) {
          // Reuse existing uid for this backendNodeId
          node.uid = existingUid;
        } else {
          // Assign new uid
          const uid = this.nextUid++;
          node.uid = uid;
          this.uidToBackendId.set(uid, backendId);
          this.backendIdToUid.set(backendId, uid);
        }
      } else {
        // No backendNodeId — assign a uid but can't resolve later
        node.uid = this.nextUid++;
      }

      if (node.children) {
        this.walkAndAssign(node.children);
      }
    }
  }

  /**
   * Resolve a uid to its backendNodeId for CDP interaction.
   * Returns `undefined` if the uid is unknown.
   */
  resolve(uid: number): number | undefined {
    return this.uidToBackendId.get(uid);
  }

  /**
   * Clear all mappings on page navigation.
   *
   * `backendNodeId` values are invalidated on navigation, so all
   * accumulated refs become stale.
   */
  onNavigation(): void {
    this.uidToBackendId.clear();
    this.backendIdToUid.clear();
    this.nextUid = 1;
  }

  /** Debugging stats */
  get stats(): { totalRefs: number; nextUid: number } {
    return {
      totalRefs: this.uidToBackendId.size,
      nextUid: this.nextUid,
    };
  }
}
