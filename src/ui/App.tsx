import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CanvasPreset,
  ColorOverrideKey,
  ConstructionElement,
  GenerationSettings,
  GridStyle,
  LineStyle,
  LogoStyle,
  AnchorShape,
  PluginToUiMessage,
  UsageState,
} from "../types/messages";

const defaultUsage: UsageState = {
  paymentStatus: "qa",
  freeLimit: Number.POSITIVE_INFINITY,
  freeUsed: 0,
  canGenerate: true,
};

export function App() {
  const [hasSelection, setHasSelection] = useState(false);
  const [hasGeneratedOutput, setHasGeneratedOutput] = useState(false);
  const [hasGeneratedSelection, setHasGeneratedSelection] = useState(false);
  const [canUseCircles, setCanUseCircles] = useState(false);
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [usage, setUsage] = useState(defaultUsage);
  const [canvasPreset, setCanvasPreset] = useState<CanvasPreset>("dark");
  const [backgroundColor, setBackgroundColor] = useState("#140D1F");
  const [backgroundOpacity, setBackgroundOpacity] = useState(1);
  const [gridEnabled, setGridEnabled] = useState(true);
  const [gridStyle, setGridStyle] = useState<GridStyle>("lines");
  const [gridColor, setGridColor] = useState("#6B4DA4");
  const [gridOpacity, setGridOpacity] = useState(0.24);
  const [gridSize, setGridSize] = useState(1);
  const [logoVisible, setLogoVisible] = useState(true);
  const [logoStyle, setLogoStyle] = useState<LogoStyle>("fill");
  const [logoOutlineColor, setLogoOutlineColor] = useState("#C9C1D1");
  const [logoOutlineOpacity, setLogoOutlineOpacity] = useState(0.18);
  const [logoFillColor, setLogoFillColor] = useState("#AFA6B8");
  const [logoFillOpacity, setLogoFillOpacity] = useState(0.56);
  const [guideColor, setGuideColor] = useState("#B783FF");
  const [guideOpacity, setGuideOpacity] = useState(0.8);
  const [lineStyle, setLineStyle] = useState<LineStyle>("solid");
  const [strokeWidth, setStrokeWidth] = useState(0.6);
  const [circles, setCircles] = useState(true);
  const [angles, setAngles] = useState(false);
  const [anchors, setAnchors] = useState(true);
  const [anchorColor, setAnchorColor] = useState("#D8FFF7");
  const [anchorOpacity, setAnchorOpacity] = useState(1);
  const [anchorSize, setAnchorSize] = useState(0.5);
  const [anchorShape, setAnchorShape] = useState<AnchorShape>("square");
  const [handles, setHandles] = useState(true);
  const [handleColor, setHandleColor] = useState("#D8FFF7");
  const [handleOpacity, setHandleOpacity] = useState(0.55);
  const [handleLineWeight, setHandleLineWeight] = useState(0.5);
  const [handleLength, setHandleLength] = useState(1);
  const [handleSize, setHandleSize] = useState(0.5);
  const colorOverrideKeysRef = useRef<Set<ColorOverrideKey>>(new Set());
  const lastLiveSettingsRef = useRef<string | null>(null);
  const skipNextLiveSettingsRef = useRef<string | null>(null);
  const lastHistorySettingsRef = useRef<string | null>(null);
  const undoSettingsRef = useRef<GenerationSettings[]>([]);
  const redoSettingsRef = useRef<GenerationSettings[]>([]);
  const isRestoringSettingsRef = useRef(false);

  const constructionElements = useMemo<ConstructionElement[]>(() => {
    const elements: ConstructionElement[] = [];
    if (canUseCircles && circles) elements.push("circles");
    if (angles) elements.push("angles");
    if (anchors) elements.push("anchors");
    if (handles) elements.push("handles");
    return elements;
  }, [angles, anchors, canUseCircles, circles, handles]);

  const settings = useMemo<GenerationSettings>(
    () => ({
      mode: "construction",
      constructionElements,
      clearspaceUnit: "logomark",
      clearspaceValue: 60,
      canvasPreset,
      backgroundColor,
      backgroundOpacity,
      gridEnabled,
      gridStyle,
      gridColor,
      gridOpacity,
      logoVisible,
      logoStyle,
      logoOutlineColor,
      logoOutlineOpacity,
      logoFillColor,
      logoFillOpacity,
      guideColor,
      guideOpacity,
      lineStyle,
      strokeWidth,
      gridSize,
      anchorColor,
      anchorOpacity,
      anchorSize,
      anchorShape,
      handleColor,
      handleOpacity,
      handleLineWeight,
      handleLength,
      handleSize,
      colorOverrides: currentColorOverrides(),
      lockGuidelines: true,
      replacePrevious: false,
    }),
    [
      anchorColor,
      anchorOpacity,
      anchorSize,
      anchorShape,
      angles,
      backgroundColor,
      backgroundOpacity,
      canvasPreset,
      circles,
      constructionElements,
      gridEnabled,
      gridStyle,
      gridColor,
      gridOpacity,
      gridSize,
      guideColor,
      guideOpacity,
      handleColor,
      handleOpacity,
      handleLineWeight,
      handleLength,
      handleSize,
      lineStyle,
      logoFillColor,
      logoFillOpacity,
      logoOutlineColor,
      logoOutlineOpacity,
      logoStyle,
      logoVisible,
      strokeWidth,
    ],
  );

  useEffect(() => {
    window.onmessage = (event: MessageEvent<{ pluginMessage?: PluginToUiMessage }>) => {
      const pluginMessage = event.data.pluginMessage;
      if (!pluginMessage) return;

      if (pluginMessage.type === "state") {
        setHasSelection(pluginMessage.hasSelection);
        setHasGeneratedOutput(pluginMessage.hasGeneratedOutput);
        setHasGeneratedSelection(pluginMessage.hasGeneratedSelection);
        setCanUseCircles(pluginMessage.canUseCircles);
        setUsage(pluginMessage.usage);
      }

      if (pluginMessage.type === "generation-complete") {
        setIsGenerating(false);
        setUsage(pluginMessage.usage);
        setHasGeneratedOutput(true);
        const syncedSettings = syncAppliedColors(pluginMessage.appliedSettings);
        const serializedSyncedSettings = JSON.stringify(syncedSettings);
        lastLiveSettingsRef.current = serializedSyncedSettings;
        lastHistorySettingsRef.current = serializedSyncedSettings;
        skipNextLiveSettingsRef.current = serializedSyncedSettings;
      }

      if (pluginMessage.type === "generation-error") {
        setIsGenerating(false);
        console.warn(pluginMessage.message);
      }
    };

    parent.postMessage({ pluginMessage: { type: "init" } }, "*");
  }, [settings]);

  function syncAppliedColors(appliedSettings: GenerationSettings): GenerationSettings {
    setBackgroundColor(appliedSettings.backgroundColor);
    setBackgroundOpacity(appliedSettings.backgroundOpacity);
    setGridColor(appliedSettings.gridColor);
    setLogoOutlineColor(appliedSettings.logoOutlineColor);
    setLogoFillColor(appliedSettings.logoFillColor);
    setGuideColor(appliedSettings.guideColor);
    setAnchorColor(appliedSettings.anchorColor);
    setHandleColor(appliedSettings.handleColor);

    return {
      ...settings,
      backgroundColor: appliedSettings.backgroundColor,
      backgroundOpacity: appliedSettings.backgroundOpacity,
      gridColor: appliedSettings.gridColor,
      logoOutlineColor: appliedSettings.logoOutlineColor,
      logoFillColor: appliedSettings.logoFillColor,
      guideColor: appliedSettings.guideColor,
      anchorColor: appliedSettings.anchorColor,
      handleColor: appliedSettings.handleColor,
      colorOverrides: currentColorOverrides(),
      replacePrevious: false,
    };
  }

  function currentColorOverrides(): ColorOverrideKey[] {
    return Array.from(colorOverrideKeysRef.current).sort();
  }

  function updateManualColor(key: ColorOverrideKey, setter: (value: string) => void, value: string) {
    colorOverrideKeysRef.current.add(key);
    setter(value);
  }

  function updateManualOpacity(key: ColorOverrideKey, setter: (value: number) => void, value: number) {
    colorOverrideKeysRef.current.add(key);
    setter(value);
  }

  useEffect(() => {
    const serializedSettings = JSON.stringify(settings);

    if (isRestoringSettingsRef.current) {
      isRestoringSettingsRef.current = false;
      lastHistorySettingsRef.current = serializedSettings;
      return;
    }

    if (lastHistorySettingsRef.current && lastHistorySettingsRef.current !== serializedSettings) {
      undoSettingsRef.current.push(parseSettingsSnapshot(lastHistorySettingsRef.current));
      if (undoSettingsRef.current.length > 80) {
        undoSettingsRef.current.shift();
      }
      redoSettingsRef.current = [];
    }

    lastHistorySettingsRef.current = serializedSettings;
  }, [settings]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isUndoShortcut = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
      const isRedoShortcut =
        ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") ||
        (event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "y");

      if ((!isUndoShortcut && !isRedoShortcut) || isTextEditingElement(document.activeElement)) {
        return;
      }

      event.preventDefault();
      if (isUndoShortcut && undoSettingsRef.current.length > 0) {
        const previousSettings = undoSettingsRef.current.pop();
        if (previousSettings) {
          redoSettingsRef.current.push(cloneSettingsSnapshot(settings));
          restoreSettingsSnapshot(previousSettings);
          return;
        }
      }

      if (isRedoShortcut && redoSettingsRef.current.length > 0) {
        const nextSettings = redoSettingsRef.current.pop();
        if (nextSettings) {
          undoSettingsRef.current.push(cloneSettingsSnapshot(settings));
          restoreSettingsSnapshot(nextSettings);
          return;
        }
      }

      parent.postMessage(
        {
          pluginMessage: isRedoShortcut
            ? {
                type: "redo",
                settings: {
                  ...settings,
                  replacePrevious: true,
                },
              }
            : { type: "undo" },
        },
        "*",
      );
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settings]);

  function restoreSettingsSnapshot(nextSettings: GenerationSettings) {
    isRestoringSettingsRef.current = true;
    applySettingsToUi({
      ...nextSettings,
      replacePrevious: false,
    });
  }

  useEffect(() => {
    if (!hasGeneratedOutput) return;

    const serializedSettings = JSON.stringify(settings);
    if (skipNextLiveSettingsRef.current === serializedSettings) {
      skipNextLiveSettingsRef.current = null;
      lastLiveSettingsRef.current = serializedSettings;
      return;
    }

    if (lastLiveSettingsRef.current === serializedSettings) return;

    lastLiveSettingsRef.current = serializedSettings;
    const timeoutId = window.setTimeout(() => {
      setIsGenerating(true);
      parent.postMessage({
        pluginMessage: {
          type: "generate",
          settings: {
            ...settings,
            replacePrevious: true,
          },
        },
      }, "*");
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [hasGeneratedOutput, settings]);

  useEffect(() => {
    function updateScrollState() {
      const scroller = document.scrollingElement ?? document.documentElement;
      const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      setIsScrolledToBottom(distanceToBottom <= 2);
    }

    updateScrollState();
    window.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    return () => {
      window.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, []);

  function applyGrid() {
    if (isGenerating) return;
    setIsGenerating(true);
    parent.postMessage({
      pluginMessage: {
        type: "generate",
        settings: {
          ...settings,
          replacePrevious: hasGeneratedOutput,
        },
      },
    }, "*");
    lastLiveSettingsRef.current = JSON.stringify(settings);
  }

  function randomize() {
    if (isGenerating) return;
    const nextCanvasPreset: CanvasPreset = Math.random() > 0.5 ? "dark" : "light";
    const palette = randomPalette(nextCanvasPreset);
    const nextConstructionElements = canUseCircles ? randomConstructionElements() : randomConstructionElements().filter((element) => element !== "circles");
    const randomizedColorKeys: ColorOverrideKey[] = ["backgroundColor", "gridColor", "logoOutlineColor", "logoFillColor", "guideColor", "anchorColor", "handleColor"];

    const nextSettings: GenerationSettings = {
      ...settings,
      constructionElements: nextConstructionElements,
      canvasPreset: nextCanvasPreset,
      backgroundColor: palette.backgroundColor,
      gridColor: palette.gridColor,
      gridEnabled: Math.random() > 0.16,
      logoOutlineColor: palette.logoOutlineColor,
      logoFillColor: palette.logoFillColor,
      logoVisible: settings.logoVisible,
      guideColor: palette.guideColor,
      anchorColor: palette.anchorColor,
      handleColor: palette.handleColor,
      gridStyle: Math.random() > 0.5 ? "dots" : "lines",
      logoStyle: Math.random() > 0.5 ? "fill" : "outline",
      lineStyle: Math.random() > 0.72 ? "dashed" : "solid",
      anchorShape: Math.random() > 0.55 ? "circle" : "square",
      colorOverrides: Array.from(new Set([...currentColorOverrides(), ...randomizedColorKeys])).sort(),
      replacePrevious: false,
    };

    for (const key of randomizedColorKeys) {
      colorOverrideKeysRef.current.add(key);
    }

    applySettingsToUi(nextSettings);
  }

  function applySettingsToUi(nextSettings: GenerationSettings) {
    colorOverrideKeysRef.current = new Set(nextSettings.colorOverrides ?? []);
    setCanvasPreset(nextSettings.canvasPreset);
    setBackgroundColor(nextSettings.backgroundColor);
    setBackgroundOpacity(nextSettings.backgroundOpacity);
    setGridColor(nextSettings.gridColor);
    setGridOpacity(nextSettings.gridOpacity);
    setLogoOutlineColor(nextSettings.logoOutlineColor);
    setLogoOutlineOpacity(nextSettings.logoOutlineOpacity);
    setLogoFillColor(nextSettings.logoFillColor);
    setLogoFillOpacity(nextSettings.logoFillOpacity);
    setGuideColor(nextSettings.guideColor);
    setGuideOpacity(nextSettings.guideOpacity);
    setAnchorColor(nextSettings.anchorColor);
    setAnchorOpacity(nextSettings.anchorOpacity);
    setAnchorSize(clampNumber(nextSettings.anchorSize, 0.1, 2));
    setHandleColor(nextSettings.handleColor);
    setHandleOpacity(nextSettings.handleOpacity);
    setHandleLineWeight(clampNumber(nextSettings.handleLineWeight ?? 0.5, 0.1, 2));
    setHandleLength(clampNumber(nextSettings.handleLength ?? 1, 0.1, 2));
    setHandleSize(clampNumber(nextSettings.handleSize, 0.1, 2));
    setGridEnabled(nextSettings.gridEnabled);
    setGridSize(nextSettings.gridSize);
    setLogoVisible(nextSettings.logoVisible);
    setCircles(nextSettings.constructionElements.includes("circles"));
    setAngles(nextSettings.constructionElements.includes("angles"));
    setAnchors(nextSettings.constructionElements.includes("anchors"));
    setHandles(nextSettings.constructionElements.includes("handles"));
    setGridStyle(nextSettings.gridStyle);
    setLogoStyle(nextSettings.logoStyle);
    setLineStyle(nextSettings.lineStyle);
    setAnchorShape(nextSettings.anchorShape);
  }

  function applyCanvasPreset(value: CanvasPreset) {
    setCanvasPreset(value);
    if (value === "light") {
      setBackgroundColor("#F2F2ED");
      setGridColor("#D9D9D2");
      setGridOpacity(0.58);
      return;
    }

    setBackgroundColor("#140D1F");
    setGridColor("#6B4DA4");
    setGridOpacity(0.24);
  }

  return (
    <main className={isScrolledToBottom ? "app-shell at-scroll-bottom" : "app-shell"}>
      <div className="bento-grid">
        <Panel title="Canvas">
          <SegmentedControl value={canvasPreset} options={[["dark", "Dark"], ["light", "Light"]]} onChange={(value) => applyCanvasPreset(value as CanvasPreset)} />
          <ColorOpacityField
            label="Background"
            color={backgroundColor}
            opacity={backgroundOpacity}
            onColorChange={(value) => updateManualColor("backgroundColor", setBackgroundColor, value)}
            onOpacityChange={(value) => updateManualOpacity("backgroundOpacity", setBackgroundOpacity, value)}
          />
          <SwitchRow label="Grid" checked={gridEnabled} onChange={setGridEnabled} />
          <SegmentedControl value={gridStyle} options={[["lines", "Lines"], ["dots", "Dots"]]} onChange={(value) => setGridStyle(value as GridStyle)} />
          <ColorOpacityField label="Grid color" color={gridColor} opacity={gridOpacity} onColorChange={(value) => updateManualColor("gridColor", setGridColor, value)} onOpacityChange={setGridOpacity} />
          <NumberField label="Grid size" value={gridSize} min={0.1} max={1} step={0.1} onChange={setGridSize} />
        </Panel>

        <Panel title="Logo">
          <SwitchRow label="Show" checked={logoVisible} onChange={setLogoVisible} />
          <SegmentedControl value={logoStyle} options={[["outline", "Outline"], ["fill", "Fill"]]} onChange={(value) => setLogoStyle(value as LogoStyle)} />
          <ColorOpacityField label="Outline color" color={logoOutlineColor} opacity={logoOutlineOpacity} onColorChange={(value) => updateManualColor("logoOutlineColor", setLogoOutlineColor, value)} onOpacityChange={setLogoOutlineOpacity} />
          <ColorOpacityField label="Fill color" color={logoFillColor} opacity={logoFillOpacity} onColorChange={(value) => updateManualColor("logoFillColor", setLogoFillColor, value)} onOpacityChange={setLogoFillOpacity} />
        </Panel>

        <Panel title="Paths">
          <NumberField label="Weight" value={strokeWidth} min={0.1} max={5} step={0.1} onChange={setStrokeWidth} />
          <ColorOpacityField label="Color" color={guideColor} opacity={guideOpacity} onColorChange={(value) => updateManualColor("guideColor", setGuideColor, value)} onOpacityChange={setGuideOpacity} />
          <SegmentedControl value={lineStyle} options={[["solid", "Solid"], ["dashed", "Dashed"]]} onChange={(value) => setLineStyle(value as LineStyle)} />
          {canUseCircles ? <SwitchRow label="Circles" checked={circles} onChange={setCircles} /> : null}
          <SwitchRow label="Angles" checked={angles} onChange={setAngles} />
        </Panel>

        <Panel title="Points">
          <SwitchRow label="Anchors" checked={anchors} onChange={setAnchors} />
          <ColorOpacityField label="Anchor color" color={anchorColor} opacity={anchorOpacity} onColorChange={(value) => updateManualColor("anchorColor", setAnchorColor, value)} onOpacityChange={setAnchorOpacity} />
          <SegmentedControl value={anchorShape} options={[["square", "Square"], ["circle", "Circle"]]} onChange={(value) => setAnchorShape(value as AnchorShape)} />
          <NumberField label="Anchor size" value={anchorSize} min={0.1} max={2} step={0.1} onChange={setAnchorSize} />
          <SwitchRow label="Handles" checked={handles} onChange={setHandles} />
          <ColorOpacityField label="Handle color" color={handleColor} opacity={handleOpacity} onColorChange={(value) => updateManualColor("handleColor", setHandleColor, value)} onOpacityChange={setHandleOpacity} />
          <NumberField label="Handle line" value={handleLineWeight} min={0.1} max={2} step={0.1} onChange={setHandleLineWeight} />
          <NumberField label="Handle length" value={handleLength} min={0.1} max={2} step={0.1} onChange={setHandleLength} />
          <NumberField label="Handle size" value={handleSize} min={0.1} max={2} step={0.1} onChange={setHandleSize} />
        </Panel>
      </div>

      <div className="action-row">
        <div
          className={hasSelection ? "action-tooltip" : "action-tooltip show-tooltip"}
          data-tooltip="Select one logo or frame before running Logrid."
          tabIndex={hasSelection ? -1 : 0}
        >
          <button className={isGenerating ? "primary-button is-loading" : "primary-button"} type="button" disabled={isGenerating || !hasSelection} onClick={hasGeneratedSelection ? randomize : applyGrid}>
            {isGenerating ? <span className="button-spinner" aria-hidden="true" /> : null}
            {isGenerating ? "Generating" : hasGeneratedSelection ? "Random" : "Generate"}
          </button>
        </div>
      </div>
    </main>
  );
}

function isTextEditingElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return ["email", "number", "password", "search", "tel", "text", "url"].includes(element.type);
}

function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{props.title}</h2>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

function SegmentedControl(props: { value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return (
    <div className="segmented-control">
      {props.options.map(([value, label]) => (
        <button className={props.value === value ? "active" : ""} type="button" key={value} onClick={() => props.onChange(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function NumberField(props: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  function commitValue(value: string | number) {
    const parsed = typeof value === "number" ? value : parseFiniteInput(value);
    if (parsed === null) return;
    props.onChange(clampNumber(parsed, props.min, props.max));
  }

  return (
    <div className="field-row">
      <label>{props.label}</label>
      <div className="range-input">
        <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(event) => commitValue(event.target.value)} />
        <input type="number" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(event) => commitValue(event.target.value)} />
      </div>
    </div>
  );
}

function ColorOpacityField(props: {
  label: string;
  color: string;
  opacity: number;
  onColorChange: (value: string) => void;
  onOpacityChange: (value: number) => void;
}) {
  return (
    <div className="field-row">
      <label>{props.label}</label>
      <div className="color-opacity-input">
        <input type="color" value={toColorInputValue(props.color)} onChange={(event) => props.onColorChange(event.target.value)} />
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={Math.round(props.opacity * 100)}
          onChange={(event) => {
            const parsed = parseFiniteInput(event.target.value);
            if (parsed === null) return;
            props.onOpacityChange(clampNumber(parsed, 0, 100) / 100);
          }}
        />
      </div>
    </div>
  );
}

function parseFiniteInput(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toColorInputValue(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
}

function cloneSettingsSnapshot(settings: GenerationSettings): GenerationSettings {
  return {
    ...settings,
    constructionElements: [...settings.constructionElements],
    colorOverrides: [...(settings.colorOverrides ?? [])],
    replacePrevious: false,
  };
}

function parseSettingsSnapshot(value: string): GenerationSettings {
  return cloneSettingsSnapshot(JSON.parse(value) as GenerationSettings);
}

function randomConstructionElements(): ConstructionElement[] {
  const elements: ConstructionElement[] = [];
  const includeCircles = Math.random() > 0.3;
  const includeAngles = Math.random() > 0.55;
  const includeAnchors = Math.random() > 0.2;
  const includeHandles = includeAnchors && Math.random() > 0.35;

  if (includeCircles) elements.push("circles");
  if (includeAngles) elements.push("angles");
  if (includeAnchors) elements.push("anchors");
  if (includeHandles) elements.push("handles");

  if (elements.length === 0) {
    elements.push("circles");
  }

  return elements;
}

function randomPalette(canvasPreset: CanvasPreset) {
  const baseHue = Math.random() * 360;
  const accentHue = wrapHue(baseHue + randomBetween(-28, 28));
  const secondaryHue = wrapHue(baseHue + randomBetween(8, 42));
  const saturation = randomBetween(0.46, 0.82);

  if (canvasPreset === "light") {
    return {
      backgroundColor: hslToHex(baseHue, saturation * 0.1, randomBetween(0.93, 0.98)),
      gridColor: hslToHex(baseHue, saturation * 0.18, randomBetween(0.74, 0.84)),
      logoOutlineColor: hslToHex(baseHue, saturation * 0.42, randomBetween(0.26, 0.38)),
      logoFillColor: hslToHex(baseHue, saturation * 0.28, randomBetween(0.42, 0.58)),
      guideColor: hslToHex(accentHue, saturation * 0.9, randomBetween(0.36, 0.52)),
      anchorColor: hslToHex(secondaryHue, saturation, randomBetween(0.28, 0.44)),
      handleColor: hslToHex(accentHue, saturation * 0.72, randomBetween(0.38, 0.54)),
    };
  }

  return {
    backgroundColor: hslToHex(baseHue, saturation * 0.34, randomBetween(0.05, 0.13)),
    gridColor: hslToHex(baseHue, saturation * 0.28, randomBetween(0.28, 0.42)),
    logoOutlineColor: hslToHex(baseHue, saturation * 0.2, randomBetween(0.72, 0.88)),
    logoFillColor: hslToHex(baseHue, saturation * 0.16, randomBetween(0.52, 0.68)),
    guideColor: hslToHex(accentHue, saturation * 0.92, randomBetween(0.58, 0.76)),
    anchorColor: hslToHex(secondaryHue, saturation, randomBetween(0.68, 0.86)),
    handleColor: hslToHex(accentHue, saturation * 0.74, randomBetween(0.62, 0.8)),
  };
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (hue < 60) {
    r = chroma;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = chroma;
  } else if (hue < 180) {
    g = chroma;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = chroma;
  } else if (hue < 300) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }

  return `#${[r, g, b]
    .map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function SwitchRow(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="switch-row">
      <span>{props.label}</span>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
    </label>
  );
}
