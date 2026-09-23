# How detection works

## Component detection

Omlet detects and tracks the components that are defined and exported from JS/TS modules. Local components — components used within the same module that are _not_ exported — are not surfaced in Omlet.

In the example below, only `ExportedButton` will be tracked because it is defined and exported. `Button` is a local component used only within the `button.tsx` module, so it is excluded from the scanned results.

```jsx
// button.tsx
function Button() {
  ...
}

export function ExportedButton() {
  ...

  return <Button/>;
}
```

### Component libraries published to npm

If you own and manage a published component library, you can scan it with Omlet CLI like any other repository. Omlet will automatically detect dependencies and usage relationships between repositories.

### 3rd-party libraries

Omlet will detect the usage of components from 3rd-party libraries like MUI or Ant and tag them as "external" automatically. Omlet only detects components used inside your project — not all the components defined in the external library.

## Usage detection

Omlet detects and counts the unique usage of each component. If a component is used multiple times within the same component, Omlet counts it as a single usage.

In the example below, there are multiple instances of `ListItem` within `ListView`, but Omlet counts this as a single usage of `ListItem`.

Omlet will also recognize that `ListView` uses `Button` indirectly through a local component `ListButton`. However, `ListButton` will not appear in the results.

```jsx
// Listview.tsx
import Button from "./Button";
import ListItem from "./ListItem";

function ListButton() {
  ...

  return <Button/>;
}

export function ListView() {
  ...

  return (
    <div>
      <div><ListItem/></div>
      ...
      <div><ListItem/></div>
      <div><ListButton/></div>
    </div>
  );
}
```

## Props detection

Omlet detects and identifies the props defined in each component and tracks the usage of those props in the component instances. See [Props tracking](../dashboard/components/props-tracking.md) for details.

## Component families (subcomponents)

Omlet recognizes when a root component and related components form a component family. This is detected automatically when components follow dotted naming (`Button.Primary`, `Button.Secondary`) or prefix naming (`ButtonPrimary`, `ButtonSecondary`). Omlet also handles subcomponents re-exported as namespaces (`export * as Button from './button-parts'`).

See [Subcomponents](../dashboard/components/subcomponents.md) for how this is surfaced in the dashboard.

---

← [FAQs](./README.md) · [Monorepo support](./monorepo-support.md) →
