# Layout

Layout is a lightweight floor-plan and tile-layout tool in the Buildr family. Draw a room, add walls and openings, enter the material and grout dimensions, then balance or fine-tune the tile starting point before installation.

## Current capabilities

- Draw rectangular or custom room perimeters
- Draw, select, resize, and precisely dimension walls and openings
- Set wall thickness
- Preview tile and grout at scale inside the room shape
- Rotate material, automatically balance perimeter cuts, and nudge the starting point
- Flag small edge cuts and estimate floor area and tile quantity with waste
- Undo and redo drawing changes
- Automatically save the working draft on the device
- Responsive desktop and mobile workspaces

## Development

```bash
npm install
npm run dev -- --hostname 127.0.0.1
```

Open `http://127.0.0.1:3000`.

## Validation

```bash
npm run build
npm run lint
```
