// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// UI Primitive barrel export
// Import from "@/lib/ui" to access all design-system primitives.

export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { Card, CardHeader, CardTitle, CardContent } from "./Card";
export type {
  CardProps,
  CardHeaderProps,
  CardTitleProps,
  CardContentProps,
} from "./Card";

export { Badge } from "./Badge";
export type { BadgeProps, BadgeVariant } from "./Badge";

export { Tabs, TabsList, TabsTrigger, TabsContent } from "./Tabs";
export type {
  TabsProps,
  TabsListProps,
  TabsTriggerProps,
  TabsContentProps,
} from "./Tabs";

export { Panel } from "./Panel";
export type { PanelProps } from "./Panel";

export {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "./Table";
export type {
  TableProps,
  TableHeadProps,
  TableBodyProps,
  TableRowProps,
  TableHeaderCellProps,
  TableCellProps,
} from "./Table";

export { Dialog } from "./Dialog";
export type { DialogProps } from "./Dialog";

export { ToastProvider, useToast } from "./Toast";
export type { ToastItem, ToastVariant } from "./Toast";

export { Skeleton, SkeletonBlock } from "./Skeleton";
export type { SkeletonProps, SkeletonBlockProps } from "./Skeleton";

export { CommandPalette } from "./CommandPalette";
export type { CommandPaletteProps, CommandItem } from "./CommandPalette";

export { useModalBehavior, usePresence } from "./useModalBehavior";
export type { UseModalBehaviorOptions } from "./useModalBehavior";
