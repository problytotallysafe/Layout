"use client";

import {
  BrickWall, Check, ChevronDown, DoorOpen, Grid3X3, MousePointer2, PencilRuler,
  Redo2, RotateCw, Save, Sparkles, SquareDashedMousePointer, Undo2,
  ZoomIn, ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };
type DrawItem = { id: string; type: "wall" | "opening"; start: Point; end: Point; thickness: number };
type Tool = "select" | "room" | "wall" | "opening";
type DragState =
  | { kind: "draw"; start: Point; current: Point }
  | { kind: "endpoint"; id: string; endpoint: "start" | "end" }
  | null;
type Snapshot = { room: Point[]; items: DrawItem[] };

const VIEW_W = 240;
const VIEW_H = 160;
const DEFAULT_ROOM: Point[] = [
  { x: 48, y: 20 }, { x: 192, y: 20 }, { x: 192, y: 140 }, { x: 48, y: 140 },
];
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const formatLength = (inches: number) => {
  const rounded = Math.max(0, Math.round(inches));
  return `${Math.floor(rounded / 12)}′ ${rounded % 12}″`;
};
const polygonArea = (points: Point[]) => Math.abs(points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0)) / 2;
const roomBounds = (room: Point[]) => {
  const xs = room.map((point) => point.x);
  const ys = room.map((point) => point.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};
const isRectangle = (room: Point[]) => room.length === 4 && room.every((point, index) => {
  const next = room[(index + 1) % room.length];
  return point.x === next.x || point.y === next.y;
});

function balancedOffset(span: number, tile: number, grout: number) {
  const pitch = tile + grout;
  let best = { offset: 0, score: -1, left: 0, right: 0 };
  for (let offset = -pitch; offset <= 0; offset += 0.125) {
    const intersections: { start: number; end: number }[] = [];
    for (let start = offset; start < span; start += pitch) {
      const end = start + tile;
      const visibleStart = Math.max(0, start);
      const visibleEnd = Math.min(span, end);
      if (visibleEnd > visibleStart) intersections.push({ start: visibleStart, end: visibleEnd });
    }
    if (!intersections.length) continue;
    const left = intersections[0].end - intersections[0].start;
    const last = intersections[intersections.length - 1];
    const right = last.end - last.start;
    const score = (Math.min(left, right) / tile) * 10 + (1 - Math.abs(left - right) / tile);
    if (score > best.score) best = { offset, score, left, right };
  }
  return best;
}

function edgeCuts(span: number, tile: number, grout: number, rawOffset: number) {
  const pitch = tile + grout;
  const offset = ((rawOffset % pitch) + pitch) % pitch - pitch;
  const intersections: { start: number; end: number }[] = [];
  for (let start = offset; start < span; start += pitch) {
    const visibleStart = Math.max(0, start);
    const visibleEnd = Math.min(span, start + tile);
    if (visibleEnd > visibleStart) intersections.push({ start: visibleStart, end: visibleEnd });
  }
  if (!intersections.length) return { left: 0, right: 0 };
  const last = intersections[intersections.length - 1];
  return {
    left: intersections[0].end - intersections[0].start,
    right: last.end - last.start,
  };
}

function NumberField({ label, value, onChange, suffix, min = 0, step = 1 }: {
  label: string; value: number; onChange: (value: number) => void; suffix: string; min?: number; step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="number-input">
        <input aria-label={label} min={min} step={step} type="number" value={Number.isInteger(value) ? value : Number(value.toFixed(3))}
          onChange={(event) => onChange(Math.max(min, Number(event.target.value) || 0))} />
        <small>{suffix}</small>
      </span>
    </label>
  );
}

export function LayoutPlanner() {
  const [projectName, setProjectName] = useState("Untitled bathroom");
  const [room, setRoom] = useState<Point[]>(DEFAULT_ROOM);
  const [draftRoom, setDraftRoom] = useState<Point[]>([]);
  const [items, setItems] = useState<DrawItem[]>([
    { id: "sample-wall", type: "wall", start: { x: 101, y: 20 }, end: { x: 101, y: 58 }, thickness: 4.5 },
    { id: "sample-opening", type: "opening", start: { x: 48, y: 62 }, end: { x: 48, y: 98 }, thickness: 4.5 },
  ]);
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [tileWidth, setTileWidth] = useState(12);
  const [tileHeight, setTileHeight] = useState(24);
  const [grout, setGrout] = useState(0.125);
  const [wallThickness, setWallThickness] = useState(4.5);
  const [origin, setOrigin] = useState<Point>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState<0 | 90>(0);
  const [showTile, setShowTile] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [saved, setSaved] = useState(true);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);

  const bounds = useMemo(() => roomBounds(room), [room]);
  const actualTileW = rotation === 0 ? tileWidth : tileHeight;
  const actualTileH = rotation === 0 ? tileHeight : tileWidth;
  const roomWidth = bounds.maxX - bounds.minX;
  const roomHeight = bounds.maxY - bounds.minY;
  const areaSqFt = polygonArea(room) / 144;
  const tileSqFt = (tileWidth * tileHeight) / 144;
  const tileCount = tileSqFt ? Math.ceil((areaSqFt / tileSqFt) * 1.1) : 0;
  const xCuts = useMemo(() => balancedOffset(roomWidth, actualTileW, grout), [roomWidth, actualTileW, grout]);
  const yCuts = useMemo(() => balancedOffset(roomHeight, actualTileH, grout), [roomHeight, actualTileH, grout]);
  const currentXCuts = useMemo(() => edgeCuts(roomWidth, actualTileW, grout, origin.x), [roomWidth, actualTileW, grout, origin.x]);
  const currentYCuts = useMemo(() => edgeCuts(roomHeight, actualTileH, grout, origin.y), [roomHeight, actualTileH, grout, origin.y]);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const minimumCut = Math.min(currentXCuts.left, currentXCuts.right, currentYCuts.left, currentYCuts.right);
  const cutWarning = minimumCut < Math.min(actualTileW, actualTileH) / 2;

  const snapshot = useCallback(() => {
    setHistory((current) => [...current.slice(-29), { room, items }]);
    setFuture([]);
    setSaved(false);
  }, [room, items]);

  useEffect(() => {
    const stored = window.localStorage.getItem("layout-draft-v1");
    if (!stored) return;
    const timer = window.setTimeout(() => {
      try {
      const parsed = JSON.parse(stored) as Snapshot & { projectName?: string; tileWidth?: number; tileHeight?: number; grout?: number; origin?: Point; rotation?: 0 | 90 };
        if (parsed.projectName) setProjectName(parsed.projectName);
        if (parsed.room?.length >= 3) setRoom(parsed.room);
        if (parsed.items) setItems(parsed.items);
        if (parsed.tileWidth) setTileWidth(parsed.tileWidth);
        if (parsed.tileHeight) setTileHeight(parsed.tileHeight);
        if (parsed.grout) setGrout(parsed.grout);
        if (parsed.origin) setOrigin(parsed.origin);
        if (parsed.rotation !== undefined) setRotation(parsed.rotation);
      } catch { /* Ignore a malformed old draft. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem("layout-draft-v1", JSON.stringify({ projectName, room, items, tileWidth, tileHeight, grout, origin, rotation }));
      setSaved(true);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [projectName, room, items, tileWidth, tileHeight, grout, origin, rotation]);

  const pointerPoint = (event: React.PointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    const visibleW = VIEW_W / zoom;
    const visibleH = VIEW_H / zoom;
    return {
      x: Math.round(clamp((event.clientX - rect.left) * visibleW / rect.width, 0, visibleW)),
      y: Math.round(clamp((event.clientY - rect.top) * visibleH / rect.height, 0, visibleH)),
    };
  };

  const startDrawing = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = pointerPoint(event);
    if (tool === "room") { setDraftRoom((current) => [...current, point]); return; }
    if (tool === "wall" || tool === "opening") {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ kind: "draw", start: point, current: point });
      setSelectedId(null);
    } else setSelectedId(null);
  };

  const movePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const point = pointerPoint(event);
    if (drag.kind === "draw") {
      const dx = Math.abs(point.x - drag.start.x);
      const dy = Math.abs(point.y - drag.start.y);
      const snapped = event.shiftKey ? (dx > dy ? { x: point.x, y: drag.start.y } : { x: drag.start.x, y: point.y }) : point;
      setDrag({ ...drag, current: snapped });
      return;
    }
    setItems((current) => current.map((item) => item.id === drag.id ? { ...item, [drag.endpoint]: point } : item));
  };

  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    if (drag.kind === "draw" && distance(drag.start, drag.current) >= 3) {
      snapshot();
      const next: DrawItem = { id: uid(), type: tool === "opening" ? "opening" : "wall", start: drag.start, end: drag.current, thickness: wallThickness };
      setItems((current) => [...current, next]);
      setSelectedId(next.id);
      setTool("select");
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  };

  const beginEndpointDrag = (event: React.PointerEvent<SVGCircleElement>, id: string, endpoint: "start" | "end") => {
    event.stopPropagation(); snapshot(); svgRef.current?.setPointerCapture(event.pointerId); setDrag({ kind: "endpoint", id, endpoint });
  };
  const finishRoom = () => { if (draftRoom.length < 3) return; snapshot(); setRoom(draftRoom); setDraftRoom([]); setTool("select"); };
  const cancelRoom = () => { setDraftRoom([]); setTool("select"); };
  const autoBalance = () => setOrigin({ x: xCuts.offset, y: yCuts.offset });
  const favorOpening = () => {
    if (!selected || selected.type !== "opening") return;
    const horizontal = Math.abs(selected.end.x - selected.start.x) >= Math.abs(selected.end.y - selected.start.y);
    const midpoint = {
      x: (selected.start.x + selected.end.x) / 2,
      y: (selected.start.y + selected.end.y) / 2,
    };
    setOrigin((current) => horizontal
      ? { ...current, x: midpoint.x - bounds.minX - actualTileW / 2 }
      : { ...current, y: midpoint.y - bounds.minY - actualTileH / 2 });
  };

  const updateSelectedLength = (nextLength: number) => {
    if (!selected || nextLength <= 0) return;
    const currentLength = distance(selected.start, selected.end) || 1;
    const scale = nextLength / currentLength;
    setItems((current) => current.map((item) => item.id === selected.id ? { ...item, end: {
      x: item.start.x + (item.end.x - item.start.x) * scale,
      y: item.start.y + (item.end.y - item.start.y) * scale,
    }} : item));
  };
  const resizeRectangle = (axis: "width" | "height", value: number) => {
    if (!isRectangle(room) || value < 24) return;
    snapshot();
    const b = roomBounds(room);
    setRoom(room.map((point) => ({
      x: axis === "width" && point.x === b.maxX ? b.minX + value : point.x,
      y: axis === "height" && point.y === b.maxY ? b.minY + value : point.y,
    })));
  };
  const undo = () => {
    const previous = history.at(-1); if (!previous) return;
    setFuture((current) => [{ room, items }, ...current]); setHistory((current) => current.slice(0, -1));
    setRoom(previous.room); setItems(previous.items); setSelectedId(null);
  };
  const redo = () => {
    const next = future[0]; if (!next) return;
    setHistory((current) => [...current, { room, items }]); setFuture((current) => current.slice(1));
    setRoom(next.room); setItems(next.items); setSelectedId(null);
  };

  const roomPath = room.map((point) => `${point.x},${point.y}`).join(" ");
  const draftPath = draftRoom.map((point) => `${point.x},${point.y}`).join(" ");
  const patternX = bounds.minX + origin.x;
  const patternY = bounds.minY + origin.y;
  const pitchX = actualTileW + grout;
  const pitchY = actualTileH + grout;
  const startX = patternX + Math.floor(((bounds.minX + bounds.maxX) / 2 - patternX) / pitchX) * pitchX;
  const startY = patternY + Math.floor(((bounds.minY + bounds.maxY) / 2 - patternY) / pitchY) * pitchY;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Layout by Buildr">
          <span className="brand-mark"><PencilRuler size={22} strokeWidth={2.25} /></span>
          <span className="brand-name">Layout</span><span className="brand-family">by Buildr</span>
        </div>
        <label className="project-name">
          <input aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} />
          <ChevronDown size={15} aria-hidden="true" />
        </label>
        <div className="header-actions">
          <span className={`save-state ${saved ? "is-saved" : ""}`}>{saved ? <Check size={14} /> : <Save size={14} />}{saved ? "Saved" : "Saving"}</span>
          <button className="icon-button" onClick={undo} disabled={!history.length} aria-label="Undo"><Undo2 size={18} /></button>
          <button className="icon-button" onClick={redo} disabled={!future.length} aria-label="Redo"><Redo2 size={18} /></button>
        </div>
      </header>

      <section className="workspace">
        <nav className="toolrail" aria-label="Drawing tools">
          {([ ["select", MousePointer2, "Select"], ["room", SquareDashedMousePointer, "Room"], ["wall", BrickWall, "Wall"], ["opening", DoorOpen, "Opening"] ] as const).map(([value, Icon, label]) => (
            <button key={value} className={tool === value ? "active" : ""} onClick={() => { setTool(value); setDraftRoom([]); setSelectedId(null); }} aria-pressed={tool === value}>
              <Icon size={21} /><span>{label}</span>
            </button>
          ))}
        </nav>

        <section className="canvas-column">
          <div className="canvas-toolbar">
            <div className="mode-copy">
              <strong>{{ select: "Select and adjust", wall: "Draw a wall", opening: "Mark an opening", room: "Draw the room perimeter" }[tool]}</strong>
              <span>{{ select: "Tap a line, then drag either end to resize it.", wall: "Drag a line. Hold Shift for perfectly straight walls.", opening: "Drag across a doorway or passage.", room: "Tap each corner, then finish the room." }[tool]}</span>
            </div>
            {tool === "room" && <div className="draft-actions"><button className="text-button" onClick={cancelRoom}>Cancel</button><button className="primary small" disabled={draftRoom.length < 3} onClick={finishRoom}>Finish room</button></div>}
            <div className="zoom-controls">
              <button onClick={() => setZoom((value) => clamp(value - 0.1, 0.8, 1.25))} aria-label="Zoom out"><ZoomOut size={17} /></button>
              <span>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((value) => clamp(value + 0.1, 0.8, 1.25))} aria-label="Zoom in"><ZoomIn size={17} /></button>
            </div>
          </div>

          <div className={`canvas-wrap tool-${tool}`}>
            <svg ref={svgRef} className="drawing-canvas" viewBox={`0 0 ${VIEW_W / zoom} ${VIEW_H / zoom}`}
              onPointerDown={startDrawing} onPointerMove={movePointer} onPointerUp={endPointer}
              role="img" aria-label="Editable floor plan and tile layout">
              <defs>
                <pattern id="minor-grid" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M 3 0 L 0 0 0 3" fill="none" stroke="#d9dfdb" strokeWidth=".25" /></pattern>
                <pattern id="major-grid" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="url(#minor-grid)" /><path d="M 12 0 L 0 0 0 12" fill="none" stroke="#b9c4bd" strokeWidth=".45" /></pattern>
                <pattern id="tile-pattern" x={patternX} y={patternY} width={actualTileW + grout} height={actualTileH + grout} patternUnits="userSpaceOnUse">
                  <rect width={actualTileW} height={actualTileH} rx=".45" fill="#d4b477" fillOpacity=".28" stroke="#b78a38" strokeWidth=".45" />
                </pattern>
                <clipPath id="room-clip"><polygon points={roomPath} /></clipPath>
              </defs>
              <rect width="100%" height="100%" fill="url(#major-grid)" />
              <polygon points={roomPath} fill="#fff" stroke="#173f32" strokeWidth="2.25" strokeLinejoin="round" />
              {showTile && <rect x={bounds.minX - actualTileW} y={bounds.minY - actualTileH} width={roomWidth + actualTileW * 2} height={roomHeight + actualTileH * 2} fill="url(#tile-pattern)" clipPath="url(#room-clip)" />}
              {showTile && <g className="start-guide" clipPath="url(#room-clip)" pointerEvents="none">
                <line x1={startX} y1={bounds.minY} x2={startX} y2={bounds.maxY} />
                <line x1={bounds.minX} y1={startY} x2={bounds.maxX} y2={startY} />
                <rect x={startX} y={startY} width={actualTileW} height={actualTileH} rx=".6" />
                <g className="start-label" transform={`translate(${startX + actualTileW / 2} ${startY + actualTileH / 2})`}>
                  <rect x="-10" y="-3.3" width="20" height="6.6" rx="2" />
                  <text y="1.25">START HERE</text>
                </g>
              </g>}
              <g className="dimensions" pointerEvents="none">
                {room.map((point, index) => { const next = room[(index + 1) % room.length]; const midpoint = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 }; return (
                  <g key={`${point.x}-${point.y}-${index}`}><rect x={midpoint.x - 9} y={midpoint.y - 3.4} width="18" height="6.8" rx="2" /><text x={midpoint.x} y={midpoint.y + 1.45}>{formatLength(distance(point, next))}</text></g>
                ); })}
              </g>
              {items.map((item) => { const isSelected = selectedId === item.id; return (
                <g key={item.id} className={`plan-item ${item.type} ${isSelected ? "selected" : ""}`} onPointerDown={(event) => { if (tool !== "select") return; event.stopPropagation(); setSelectedId(item.id); }}>
                  <line x1={item.start.x} y1={item.start.y} x2={item.end.x} y2={item.end.y} strokeWidth={item.type === "wall" ? item.thickness : Math.max(2.25, item.thickness * .55)} />
                  {item.type === "opening" && <line className="opening-center" x1={item.start.x} y1={item.start.y} x2={item.end.x} y2={item.end.y} />}
                  <text x={(item.start.x + item.end.x) / 2} y={(item.start.y + item.end.y) / 2 - item.thickness / 2 - 2}>{formatLength(distance(item.start, item.end))}</text>
                  {isSelected && <><circle cx={item.start.x} cy={item.start.y} r="2.7" onPointerDown={(event) => beginEndpointDrag(event, item.id, "start")} /><circle cx={item.end.x} cy={item.end.y} r="2.7" onPointerDown={(event) => beginEndpointDrag(event, item.id, "end")} /></>}
                </g>
              ); })}
              {drag?.kind === "draw" && <g className="draft-line" pointerEvents="none"><line x1={drag.start.x} y1={drag.start.y} x2={drag.current.x} y2={drag.current.y} strokeWidth={tool === "wall" ? wallThickness : 2.5} /><text x={(drag.start.x + drag.current.x) / 2} y={(drag.start.y + drag.current.y) / 2 - 4}>{formatLength(distance(drag.start, drag.current))}</text></g>}
              {draftRoom.length > 0 && <g className="draft-room" pointerEvents="none"><polyline points={draftPath} />{draftRoom.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2" />)}</g>}
            </svg>
            <div className="scale-note">Each small square = 3 inches</div>
          </div>
        </section>

        <aside className="inspector">
          {selected ? <section className="panel selected-panel">
            <div className="panel-heading"><span className="eyebrow">Selected</span><strong>{selected.type === "wall" ? "Wall" : "Opening"}</strong></div>
            <NumberField label="Length" value={distance(selected.start, selected.end)} onChange={updateSelectedLength} suffix="in" min={1} />
            <NumberField label={selected.type === "wall" ? "Thickness" : "Wall thickness"} value={selected.thickness} onChange={(value) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, thickness: value } : item))} suffix="in" min={1} step={.5} />
            {selected.type === "opening" && <button className="favor-button" onClick={favorOpening}><Sparkles size={16} /> Favor this opening</button>}
            <button className="delete-button" onClick={() => { snapshot(); setItems((current) => current.filter((item) => item.id !== selected.id)); setSelectedId(null); }}>Delete {selected.type}</button>
          </section> : <section className="panel">
            <div className="panel-heading"><span className="eyebrow">Room</span><strong>{isRectangle(room) ? `${formatLength(roomWidth)} × ${formatLength(roomHeight)}` : "Custom shape"}</strong></div>
            {isRectangle(room) && <div className="field-row"><NumberField label="Width" value={roomWidth} onChange={(value) => resizeRectangle("width", value)} suffix="in" min={24} /><NumberField label="Length" value={roomHeight} onChange={(value) => resizeRectangle("height", value)} suffix="in" min={24} /></div>}
            <NumberField label="New wall thickness" value={wallThickness} onChange={setWallThickness} suffix="in" min={1} step={.5} />
          </section>}

          <section className="panel tile-panel">
            <div className="panel-heading inline-heading"><span><span className="eyebrow">Material</span><strong>Tile layout</strong></span><label className="switch"><input type="checkbox" checked={showTile} onChange={(event) => setShowTile(event.target.checked)} /><span aria-hidden="true" /></label></div>
            <div className="field-row"><NumberField label="Tile width" value={tileWidth} onChange={setTileWidth} suffix="in" min={1} step={.125} /><NumberField label="Tile length" value={tileHeight} onChange={setTileHeight} suffix="in" min={1} step={.125} /></div>
            <NumberField label="Grout joint" value={grout} onChange={setGrout} suffix="in" min={.0625} step={.0625} />
            <div className="button-row"><button className="secondary" onClick={() => setRotation((value) => value === 0 ? 90 : 0)}><RotateCw size={16} /> Rotate 90°</button><button className="primary" onClick={autoBalance}><Sparkles size={16} /> Balance cuts</button></div>
            <div className="nudge-control"><span>Fine-tune starting point</span><div><button onClick={() => setOrigin((point) => ({ ...point, x: point.x - .25 }))} aria-label="Move layout left">←</button><button onClick={() => setOrigin((point) => ({ ...point, y: point.y - .25 }))} aria-label="Move layout up">↑</button><button onClick={() => setOrigin((point) => ({ ...point, y: point.y + .25 }))} aria-label="Move layout down">↓</button><button onClick={() => setOrigin((point) => ({ ...point, x: point.x + .25 }))} aria-label="Move layout right">→</button></div></div>
          </section>

          <section className="panel results-panel">
            <div className="panel-heading inline-heading"><span><span className="eyebrow">Layout check</span><strong>{cutWarning ? "Review edge cuts" : "Cuts look balanced"}</strong></span><span className={`result-icon ${cutWarning ? "warning" : ""}`}>{cutWarning ? "!" : <Check size={17} />}</span></div>
            <div className="metrics"><div><span>Floor area</span><strong>{areaSqFt.toFixed(1)} ft²</strong></div><div><span>Tile + 10%</span><strong>{tileCount} pcs</strong></div><div><span>Smallest edge cut</span><strong>{minimumCut.toFixed(1)} in</strong></div></div>
            <p>{cutWarning ? "One edge may land below half a tile. Nudge the starting point or favor the most visible wall or doorway." : "The current starting point keeps the outside cuts close to equal."}</p>
          </section>
        </aside>
      </section>

      <nav className="mobile-tools" aria-label="Drawing tools">
        {([ ["select", MousePointer2, "Select"], ["room", SquareDashedMousePointer, "Room"], ["wall", BrickWall, "Wall"], ["opening", DoorOpen, "Opening"], ["tile", Grid3X3, "Tile"] ] as const).map(([value, Icon, label]) => (
          <button key={value} className={value !== "tile" && tool === value ? "active" : ""} onClick={() => { if (value === "tile") document.querySelector(".tile-panel")?.scrollIntoView({ behavior: "smooth" }); else setTool(value); }}><Icon size={19} /><span>{label}</span></button>
        ))}
      </nav>
    </main>
  );
}
