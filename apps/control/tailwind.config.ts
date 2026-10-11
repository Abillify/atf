// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        /* Semantische Status-Farben (UI-STYLE-GUIDE.md §3). Ersetzen hart
           kodierte Tailwind-Paletten; "danger" = Status, "destructive" = Buttons. */
        success: {
          DEFAULT: "hsl(var(--success))",
          solid: "hsl(var(--success-solid))",
          "solid-hover": "hsl(var(--success-solid-hover))",
          foreground: "hsl(var(--success-foreground))",
          soft: "hsl(var(--success-soft))",
          border: "hsl(var(--success-border))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          solid: "hsl(var(--warning-solid))",
          "solid-hover": "hsl(var(--warning-solid-hover))",
          foreground: "hsl(var(--warning-foreground))",
          soft: "hsl(var(--warning-soft))",
          border: "hsl(var(--warning-border))",
        },
        danger: {
          DEFAULT: "hsl(var(--danger))",
          solid: "hsl(var(--danger-solid))",
          "solid-hover": "hsl(var(--danger-solid-hover))",
          foreground: "hsl(var(--danger-foreground))",
          soft: "hsl(var(--danger-soft))",
          border: "hsl(var(--danger-border))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          solid: "hsl(var(--info-solid))",
          "solid-hover": "hsl(var(--info-solid-hover))",
          foreground: "hsl(var(--info-foreground))",
          soft: "hsl(var(--info-soft))",
          border: "hsl(var(--info-border))",
        },
        /* Kategorie-Farben: Copilot/Optimizer, Sub-Flows, Operator-Kategorie. */
        copilot: {
          DEFAULT: "hsl(var(--copilot))",
          solid: "hsl(var(--copilot-solid))",
          "solid-hover": "hsl(var(--copilot-solid-hover))",
          foreground: "hsl(var(--copilot-foreground))",
          soft: "hsl(var(--copilot-soft))",
          border: "hsl(var(--copilot-border))",
        },
        subflow: {
          DEFAULT: "hsl(var(--subflow))",
          solid: "hsl(var(--subflow-solid))",
          "solid-hover": "hsl(var(--subflow-solid-hover))",
          foreground: "hsl(var(--subflow-foreground))",
          soft: "hsl(var(--subflow-soft))",
          border: "hsl(var(--subflow-border))",
        },
        "accent-2": {
          DEFAULT: "hsl(var(--accent-2))",
          solid: "hsl(var(--accent-2-solid))",
          "solid-hover": "hsl(var(--accent-2-solid-hover))",
          foreground: "hsl(var(--accent-2-foreground))",
          soft: "hsl(var(--accent-2-soft))",
          border: "hsl(var(--accent-2-border))",
        },
        /* Text on saturated solid fills: text-on-solid. */
        "on-solid": "hsl(var(--on-solid))",
        /* Category color slots (grouping, without status semantics). */
        "cat-1": {
          DEFAULT: "hsl(var(--cat-1))",
          soft: "hsl(var(--cat-1-soft))",
          border: "hsl(var(--cat-1-border))",
        },
        "cat-2": {
          DEFAULT: "hsl(var(--cat-2))",
          soft: "hsl(var(--cat-2-soft))",
          border: "hsl(var(--cat-2-border))",
        },
        "cat-3": {
          DEFAULT: "hsl(var(--cat-3))",
          soft: "hsl(var(--cat-3-soft))",
          border: "hsl(var(--cat-3-border))",
        },
        "cat-4": {
          DEFAULT: "hsl(var(--cat-4))",
          soft: "hsl(var(--cat-4-soft))",
          border: "hsl(var(--cat-4-border))",
        },
        "cat-5": {
          DEFAULT: "hsl(var(--cat-5))",
          soft: "hsl(var(--cat-5-soft))",
          border: "hsl(var(--cat-5-border))",
        },
        "cat-6": {
          DEFAULT: "hsl(var(--cat-6))",
          soft: "hsl(var(--cat-6-soft))",
          border: "hsl(var(--cat-6-border))",
        },
        /* Node-Kategorien (Graph-Canvas): bg-node-<kind>, border-node-<kind>-border. */
        node: {
          llm: {
            DEFAULT: "hsl(var(--node-llm))",
            border: "hsl(var(--node-llm-border))",
          },
          classifier: {
            DEFAULT: "hsl(var(--node-classifier))",
            border: "hsl(var(--node-classifier-border))",
          },
          router: {
            DEFAULT: "hsl(var(--node-router))",
            border: "hsl(var(--node-router-border))",
          },
          parallel: {
            DEFAULT: "hsl(var(--node-parallel))",
            border: "hsl(var(--node-parallel-border))",
          },
          retrieval: {
            DEFAULT: "hsl(var(--node-retrieval))",
            border: "hsl(var(--node-retrieval-border))",
          },
          memory: {
            DEFAULT: "hsl(var(--node-memory))",
            border: "hsl(var(--node-memory-border))",
          },
          tool: {
            DEFAULT: "hsl(var(--node-tool))",
            border: "hsl(var(--node-tool-border))",
          },
          "agent-harness": {
            DEFAULT: "hsl(var(--node-agent-harness))",
            border: "hsl(var(--node-agent-harness-border))",
          },
          transform: {
            DEFAULT: "hsl(var(--node-transform))",
            border: "hsl(var(--node-transform-border))",
          },
          trigger: {
            DEFAULT: "hsl(var(--node-trigger))",
            border: "hsl(var(--node-trigger-border))",
          },
          assistant: {
            DEFAULT: "hsl(var(--node-assistant))",
            border: "hsl(var(--node-assistant-border))",
          },
          boundary: {
            DEFAULT: "hsl(var(--node-boundary))",
            border: "hsl(var(--node-boundary-border))",
          },
          default: {
            DEFAULT: "hsl(var(--node-default))",
            border: "hsl(var(--node-default-border))",
          },
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};

export default config;
