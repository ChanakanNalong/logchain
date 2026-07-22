# Cylis — LogChain Security Dashboard

A recreation of the Cylis dashboard as a clean, editable React + Vite project
(rebuilt from a minified single-file export — see notes below).

## Structure

```
src/
  main.jsx           entry point
  App.jsx             sidebar, header, theme toggle, page routing
  theme.js             dark/light theme tokens + ThemeContext
  components/
    ui.jsx             Card, SectionLabel, Badge, Button, Th, Td, GlobalStyle
    LogTable.jsx        shared log table
  data/
    mockData.js         all mock data (KPIs, logs, dataset stats, etc.)
  pages/
    Dashboard.jsx        overview page (KPIs, traffic chart, top attackers, recent logs)
    Logs.jsx              searchable log explorer
    MLDetection.jsx       DeepLog metrics, loss curve, confusion matrix, sequences
    Dataset.jsx            HDFS_v1 dataset info + samples
    Verify.jsx              Merkle proof verification demo
    Reports.jsx              incident report + timeline
    Settings.jsx              alert config + RBAC roles table
```

## Getting started

```bash
npm install
npm run dev       # local dev server
npm run build      # production build -> dist/
```

## Notes on this rebuild

The original file you had was a **production build** (Vite output) — a single
HTML file with all of React, the component code, and third-party libraries
minified together. That kind of file isn't meant to be hand-edited.

This project is a full reconstruction: every page, every data value (KPI
numbers, log entries, dataset stats, RBAC roles, etc.), every icon, and the
dark-navy / light theme tokens were extracted from that build and rewritten
as normal, readable component files. It should look and behave identically
to the original, but now each page/section lives in its own file so you can
find and change things easily.

Where to make common changes:
- **Colors / theme** → `src/theme.js`
- **Any displayed numbers, logs, or table data** → `src/data/mockData.js`
- **Layout of a specific page** → the matching file in `src/pages/`
- **Buttons, badges, cards used everywhere** → `src/components/ui.jsx`
