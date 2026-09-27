// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * One icon per node type, shared by the canvas cards and the node palette so
 * a node reads the same wherever it appears.
 */
import {
  BookOpenText,
  Bot,
  Box,
  Brain,
  CircleDot,
  Database,
  GitFork,
  GraduationCap,
  IdCard,
  type LucideIcon,
  Shuffle,
  Split,
  Tags,
  Wrench,
  Zap,
} from "lucide-react";
import type { NodeVisualType } from "./graphUtils";

export function nodeTypeIcon(type: NodeVisualType | undefined): LucideIcon {
  switch (type) {
    case "llm":
      return Brain;
    case "tool":
      return Wrench;
    case "router":
      return Split;
    case "classifier":
      return Tags;
    case "parallel":
      return GitFork;
    case "retrieval":
      return BookOpenText;
    case "memory":
      return Database;
    case "agent-harness":
      return Bot;
    case "transform":
      return Shuffle;
    case "trigger":
      return Zap;
    case "assistant-context":
      return IdCard;
    case "assistant-learn":
      return GraduationCap;
    case "boundary":
      return CircleDot;
    default:
      return Box;
  }
}
