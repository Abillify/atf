// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { TokenSettings } from "../components/TokenSettings";

describe("TokenSettings", () => {
  test("opens the popover and saves a token", () => {
    const onChange = vi.fn();
    render(<TokenSettings token="" onChange={onChange} />);

    fireEvent.click(screen.getByText("Token"));
    const input = screen.getByPlaceholderText("eyJhbGc…");
    fireEvent.change(input, { target: { value: "a.b.c" } });
    fireEvent.click(screen.getByText("Save"));

    expect(onChange).toHaveBeenCalledWith("a.b.c");
  });

  test("Enter key saves", () => {
    const onChange = vi.fn();
    render(<TokenSettings token="" onChange={onChange} />);
    fireEvent.click(screen.getByText("Token"));
    const input = screen.getByPlaceholderText("eyJhbGc…");
    fireEvent.change(input, { target: { value: "x.y.z" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("x.y.z");
  });

  test("Clear emits empty string", () => {
    const onChange = vi.fn();
    render(<TokenSettings token="existing" onChange={onChange} />);
    fireEvent.click(screen.getByText("Token"));
    fireEvent.click(screen.getByText("Clear"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
