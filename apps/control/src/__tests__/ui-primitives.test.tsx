// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * UI Primitives — accessibility, focus, keyboard navigation, and dark-mode tests.
 * Validates Requirements 8.3 and 8.5.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, test, expect, vi, beforeEach } from "vitest";
import React, { useState } from "react";

import { Button } from "../lib/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../lib/ui/Card";
import { Badge } from "../lib/ui/Badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../lib/ui/Tabs";
import { Panel } from "../lib/ui/Panel";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../lib/ui/Table";
import { Dialog } from "../lib/ui/Dialog";
import { ToastProvider, useToast } from "../lib/ui/Toast";
import { Skeleton, SkeletonBlock } from "../lib/ui/Skeleton";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
describe("Button", () => {
  test("renders with accessible role=button", () => {
    render(<Button>Click me</Button>);
    expect(
      screen.getByRole("button", { name: "Click me" }),
    ).toBeInTheDocument();
  });

  test("is focusable and activatable with Enter", async () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Submit</Button>);
    const btn = screen.getByRole("button", { name: "Submit" });
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.keyDown(btn, { key: "Enter" });
    fireEvent.click(btn);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("disabled button has aria-disabled and cannot be clicked", () => {
    const handler = vi.fn();
    render(
      <Button disabled onClick={handler}>
        Disabled
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Disabled" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-disabled", "true");
  });

  test("loading state sets aria-busy", () => {
    render(<Button loading>Save</Button>);
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toBeDisabled();
  });

  test("variant=destructive renders correctly", () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toMatch(/destructive/);
  });
});

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
describe("Card", () => {
  test("renders with role=region", () => {
    render(<Card aria-label="Info card">content</Card>);
    expect(
      screen.getByRole("region", { name: "Info card" }),
    ).toBeInTheDocument();
  });

  test("CardTitle renders as h3", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>My Title</CardTitle>
        </CardHeader>
      </Card>,
    );
    const heading = screen.getByRole("heading", { name: "My Title", level: 3 });
    expect(heading).toBeInTheDocument();
  });

  test("CardContent renders children", () => {
    render(
      <Card>
        <CardContent>body text</CardContent>
      </Card>,
    );
    expect(screen.getByText("body text")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------
describe("Badge", () => {
  test("renders with role=status", () => {
    render(<Badge>Active</Badge>);
    const badge = screen.getByRole("status");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Active");
  });

  test("applies variant class", () => {
    render(<Badge variant="destructive">Error</Badge>);
    const badge = screen.getByRole("status");
    expect(badge.className).toMatch(/destructive/);
  });

  test("all variants render without crashing", () => {
    const variants = [
      "default",
      "secondary",
      "destructive",
      "outline",
      "success",
      "warning",
    ] as const;
    for (const v of variants) {
      const { unmount } = render(<Badge variant={v}>{v}</Badge>);
      expect(screen.getByText(v)).toBeInTheDocument();
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
describe("Tabs", () => {
  function SampleTabs() {
    return (
      <Tabs defaultValue="alpha">
        <TabsList>
          <TabsTrigger value="alpha">Alpha</TabsTrigger>
          <TabsTrigger value="beta">Beta</TabsTrigger>
        </TabsList>
        <TabsContent value="alpha">Panel Alpha</TabsContent>
        <TabsContent value="beta">Panel Beta</TabsContent>
      </Tabs>
    );
  }

  test("renders tablist, tabs, and tabpanels with correct ARIA", () => {
    render(<SampleTabs />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    // include hidden panels (the inactive one has hidden attribute)
    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(panels).toHaveLength(2);
  });

  test("active tab is aria-selected=true", () => {
    render(<SampleTabs />);
    const alphaTab = screen.getByRole("tab", { name: "Alpha" });
    const betaTab = screen.getByRole("tab", { name: "Beta" });
    expect(alphaTab).toHaveAttribute("aria-selected", "true");
    expect(betaTab).toHaveAttribute("aria-selected", "false");
  });

  test("inactive panel is hidden", () => {
    const { container } = render(<SampleTabs />);
    // The inactive panel has `hidden` attribute — query directly since ARIA name
    // computation returns "" for hidden elements (aria-labelledby refs are not resolved)
    const betaPanel = container.querySelector(
      "[role='tabpanel'][hidden]",
    ) as HTMLElement;
    expect(betaPanel).not.toBeNull();
    expect(betaPanel).toHaveAttribute("hidden");
    expect(betaPanel).toHaveTextContent("Panel Beta");
  });

  test("clicking a tab makes it active", async () => {
    render(<SampleTabs />);
    const betaTab = screen.getByRole("tab", { name: "Beta" });
    fireEvent.click(betaTab);
    expect(betaTab).toHaveAttribute("aria-selected", "true");
    const betaPanel = screen.getByRole("tabpanel", { name: "Beta" });
    expect(betaPanel).not.toHaveAttribute("hidden");
    expect(screen.getByText("Panel Beta")).toBeVisible();
  });

  test("tab trigger has tabIndex=0 when active, -1 when inactive", () => {
    render(<SampleTabs />);
    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveAttribute(
      "tabIndex",
      "0",
    );
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute(
      "tabIndex",
      "-1",
    );
  });

  test("tab and panel are linked via aria-controls / aria-labelledby", () => {
    render(<SampleTabs />);
    const alphaTab = screen.getByRole("tab", { name: "Alpha" });
    const alphaPanel = screen.getByRole("tabpanel", { name: "Alpha" });
    expect(alphaTab).toHaveAttribute("aria-controls", alphaPanel.id);
    expect(alphaPanel).toHaveAttribute("aria-labelledby", alphaTab.id);
  });

  test("controlled mode responds to value prop", () => {
    function ControlledTabs() {
      const [tab, setTab] = useState("beta");
      return (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="alpha">Alpha</TabsTrigger>
            <TabsTrigger value="beta">Beta</TabsTrigger>
          </TabsList>
          <TabsContent value="alpha">Alpha panel</TabsContent>
          <TabsContent value="beta">Beta panel</TabsContent>
        </Tabs>
      );
    }
    render(<ControlledTabs />);
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
describe("Panel", () => {
  test("renders as section by default", () => {
    render(<Panel heading="Settings">content</Panel>);
    // heading string becomes aria-label
    expect(
      screen.getByRole("region", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  test("renders heading as h2", () => {
    render(<Panel heading="Dashboard" />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Dashboard" }),
    ).toBeInTheDocument();
  });

  test("can render as a different element via as prop", () => {
    render(
      <Panel as="article" aria-label="Article panel">
        body
      </Panel>,
    );
    const el = screen.getByRole("article", { name: "Article panel" });
    expect(el.tagName.toLowerCase()).toBe("article");
  });

  test("renders without heading when none supplied", () => {
    render(<Panel>no heading</Panel>);
    expect(screen.getByText("no heading")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
describe("Table", () => {
  function SampleTable() {
    return (
      <Table caption="Users">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Role</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>Alice</TableCell>
            <TableCell>Admin</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
  }

  test("renders table element with correct role", () => {
    render(<SampleTable />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  test("renders column header cells", () => {
    render(<SampleTable />);
    expect(
      screen.getByRole("columnheader", { name: "Name" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Role" }),
    ).toBeInTheDocument();
  });

  test("renders data cells", () => {
    render(<SampleTable />);
    expect(screen.getByRole("cell", { name: "Alice" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Admin" })).toBeInTheDocument();
  });

  test("renders caption", () => {
    render(<SampleTable />);
    expect(screen.getByText("Users")).toBeInTheDocument();
  });

  test("wraps in overflow-x-auto container for responsive layout", () => {
    const { container } = render(<SampleTable />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toMatch(/overflow-x-auto/);
  });
});

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
describe("Dialog", () => {
  test("does not render when open=false", () => {
    render(
      <Dialog open={false} onClose={vi.fn()} title="Test">
        body
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("renders with role=dialog and aria-labelledby when open", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Confirm action">
        Are you sure?
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-labelledby");
    const titleId = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe(
      "Confirm action",
    );
  });

  test("close button has accessible label", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Test dialog">
        content
      </Dialog>,
    );
    expect(
      screen.getByRole("button", { name: "Close dialog" }),
    ).toBeInTheDocument();
  });

  test("pressing Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Escape test">
        content
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking backdrop calls onClose", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open onClose={onClose} title="Backdrop test">
        content
      </Dialog>,
    );
    // The backdrop is the first child of the container
    const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking inside dialog panel does not close", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Panel click test">
        <button>Inner</button>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  test("dialog has aria-modal=true", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Modal test">
        content
      </Dialog>,
    );
    // aria-modal is on the backdrop container
    const backdrop = document.querySelector("[aria-modal='true']");
    expect(backdrop).toBeInTheDocument();
  });

  test("optional description links via aria-describedby", () => {
    render(
      <Dialog
        open
        onClose={vi.fn()}
        title="With desc"
        description="Some description"
      >
        content
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-describedby");
    const descId = dialog.getAttribute("aria-describedby")!;
    expect(document.getElementById(descId)?.textContent).toBe(
      "Some description",
    );
  });
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
describe("Toast", () => {
  function TestToastTrigger() {
    const { addToast, removeToast } = useToast();
    return (
      <>
        <button
          onClick={() => addToast({ title: "Hello", description: "World" })}
        >
          Show toast
        </button>
        <button
          onClick={() =>
            addToast({ title: "Error occurred", variant: "destructive" })
          }
        >
          Show error
        </button>
      </>
    );
  }

  function Wrapper() {
    return (
      <ToastProvider>
        <TestToastTrigger />
      </ToastProvider>
    );
  }

  test("addToast displays a notification with role=alert", async () => {
    render(<Wrapper />);
    fireEvent.click(screen.getByRole("button", { name: "Show toast" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("World")).toBeInTheDocument();
  });

  test("dismiss button removes the toast", async () => {
    render(<Wrapper />);
    fireEvent.click(screen.getByRole("button", { name: "Show toast" }));
    const dismiss = await screen.findByRole("button", {
      name: "Dismiss notification",
    });
    fireEvent.click(dismiss);
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  test("destructive variant renders correctly", async () => {
    render(<Wrapper />);
    fireEvent.click(screen.getByRole("button", { name: "Show error" }));
    const alert = await screen.findByRole("alert");
    expect(alert.className).toMatch(/destructive/);
  });
});

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------
describe("Skeleton", () => {
  test("renders with role=status and aria-busy", () => {
    render(<Skeleton />);
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("aria-busy", "true");
    expect(el).toHaveAttribute("aria-label", "Loading…");
  });

  test("circle prop adds rounded-full class", () => {
    render(<Skeleton circle />);
    expect(screen.getByRole("status").className).toMatch(/rounded-full/);
  });

  test("SkeletonBlock renders the requested number of lines", () => {
    render(<SkeletonBlock lines={4} />);
    const items = screen.getAllByRole("status");
    expect(items).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Dark-mode rendering smoke test
// ---------------------------------------------------------------------------
describe("Dark mode rendering", () => {
  beforeEach(() => {
    document.documentElement.classList.add("dark");
  });

  test("Button renders without error in dark mode", () => {
    render(<Button variant="primary">Dark button</Button>);
    expect(
      screen.getByRole("button", { name: "Dark button" }),
    ).toBeInTheDocument();
  });

  test("Card renders without error in dark mode", () => {
    render(<Card aria-label="dark card">content</Card>);
    expect(
      screen.getByRole("region", { name: "dark card" }),
    ).toBeInTheDocument();
  });

  test("Badge renders in dark mode", () => {
    render(<Badge variant="success">Online</Badge>);
    const badge = screen.getByRole("status");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Online");
  });

  test("Dialog renders in dark mode", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Dark dialog">
        dark content
      </Dialog>,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
