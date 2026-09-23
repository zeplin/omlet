# Subcomponents

The **Subcomponents** tab on the **Component Detail** page lists all subcomponents belonging to a component family — components that share the same root name and package as the selected component.

Omlet recognizes subcomponents in two common patterns:

- **Dotted naming** — `Button.Primary`, `Button.Secondary`, `Button.Link`
- **Prefix naming** — `ButtonPrimary`, `ButtonSecondary`, `ButtonLink`

Both patterns are detected automatically during CLI analysis, including when subcomponents are exported through namespace re-exports (`export * as Button from './button-parts'`).

## View subcomponents

Open the **Subcomponents** tab on a component's detail page to see the list. Each row shows the subcomponent name and how many times it is used across projects. Click a subcomponent to open its detail page.

## Family usage

The component detail panel also shows **# Root used**, which reflects the total usage of the component family (the root component plus all of its subcomponents).

---

← [Props tracking](./props-tracking.md)
