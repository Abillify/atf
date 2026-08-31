"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (id: string) => void;
  tabListId: string;
  /** Registers a <TabsContent> panel so triggers can link to it via aria-controls. */
  registerPanel: (value: string) => void;
  unregisterPanel: (value: string) => void;
  /** True when a <TabsContent> for the given value is mounted. */
  hasPanel: (value: string) => boolean;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tabs sub-components must be used inside <Tabs>");
  return ctx;
}

export interface TabsProps {
  /** Controlled active tab id */
  value?: string;
  /** Default tab id for uncontrolled usage */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}

export function Tabs({
  value,
  defaultValue = "",
  onValueChange,
  className = "",
  children,
}: TabsProps): React.JSX.Element {
  const [internalTab, setInternalTab] = useState(defaultValue);
  const [panels, setPanels] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const tabListId = useId();

  const activeTab = value !== undefined ? value : internalTab;

  const setActiveTab = (id: string) => {
    if (value === undefined) setInternalTab(id);
    onValueChange?.(id);
  };

  const registerPanel = useCallback((panelValue: string) => {
    setPanels((prev) => {
      if (prev.has(panelValue)) return prev;
      const next = new Set(prev);
      next.add(panelValue);
      return next;
    });
  }, []);

  const unregisterPanel = useCallback((panelValue: string) => {
    setPanels((prev) => {
      if (!prev.has(panelValue)) return prev;
      const next = new Set(prev);
      next.delete(panelValue);
      return next;
    });
  }, []);

  const hasPanel = useCallback(
    (panelValue: string) => panels.has(panelValue),
    [panels],
  );

  return (
    <TabsContext.Provider
      value={{
        activeTab,
        setActiveTab,
        tabListId,
        registerPanel,
        unregisterPanel,
        hasPanel,
      }}
    >
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {}

export function TabsList({
  className = "",
  children,
  ...props
}: TabsListProps): React.JSX.Element {
  const { tabListId } = useTabsContext();
  return (
    <div
      id={tabListId}
      role="tablist"
      className={[
        "flex gap-1 overflow-x-auto border-b border-border",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "role"> {
  value: string;
}

export function TabsTrigger({
  value,
  className = "",
  children,
  ...props
}: TabsTriggerProps): React.JSX.Element {
  const { activeTab, setActiveTab, tabListId, hasPanel } = useTabsContext();
  const isActive = activeTab === value;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActiveTab(value);
    }
    props.onKeyDown?.(e);
  };

  // Only reference a panel that actually exists in the DOM. Referencing a
  // missing id is an `aria-valid-attr-value` violation, so pages that render
  // their own bodies without <TabsContent> simply get no aria-controls.
  const controlledPanelId = hasPanel(value)
    ? `${tabListId}-panel-${value}`
    : undefined;

  return (
    <button
      role="tab"
      id={`${tabListId}-tab-${value}`}
      aria-selected={isActive}
      {...(controlledPanelId ? { "aria-controls": controlledPanelId } : {})}
      tabIndex={isActive ? 0 : -1}
      onClick={() => setActiveTab(value)}
      onKeyDown={handleKeyDown}
      className={[
        "whitespace-nowrap px-4 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        isActive
          ? "border-b-2 border-accent text-accent -mb-px"
          : "text-muted-foreground hover:text-foreground",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({
  value,
  className = "",
  children,
  ...props
}: TabsContentProps): React.JSX.Element {
  const { activeTab, tabListId, registerPanel, unregisterPanel } =
    useTabsContext();
  const isActive = activeTab === value;

  useEffect(() => {
    registerPanel(value);
    return () => unregisterPanel(value);
  }, [value, registerPanel, unregisterPanel]);

  return (
    <div
      role="tabpanel"
      id={`${tabListId}-panel-${value}`}
      aria-labelledby={`${tabListId}-tab-${value}`}
      hidden={!isActive}
      tabIndex={0}
      className={[
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive ? "block" : "hidden",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}
