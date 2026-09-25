// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useCallback, useEffect, useState } from "react";
import type { NodeTypeCatalog, NodeTypeDoc } from "../lib/node-types";

/**
 * Node documentation in the Studio sidebar: follows the selected node and can
 * be closed. Closing applies to the current selection only — selecting another
 * node, or the same one again, shows the docs again — and `show()` reopens
 * them for the current node.
 */
export function useNodeDocs(
  inspect: { nodeId: string; type: string } | null,
  catalog: Pick<NodeTypeCatalog, "types"> | undefined,
): {
  /** Docs to show, or undefined (nothing selected, unknown type, or closed). */
  doc: NodeTypeDoc | undefined;
  /** Docs exist for the selection but were closed. */
  hidden: NodeTypeDoc | undefined;
  close: () => void;
  show: () => void;
} {
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const nodeId = inspect?.nodeId;
  useEffect(() => {
    setClosedFor(null);
  }, [nodeId]);
  const available = inspect ? catalog?.types.find((t) => t.type === inspect.type) : undefined;
  const closed = available !== undefined && nodeId === closedFor;
  const close = useCallback(() => setClosedFor(nodeId ?? null), [nodeId]);
  const show = useCallback(() => setClosedFor(null), []);
  return {
    doc: closed ? undefined : available,
    hidden: closed ? available : undefined,
    close,
    show,
  };
}
