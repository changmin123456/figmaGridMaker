import type { GenerationSettings, PluginToUiMessage, UiToPluginMessage, UsageState } from "./types/messages";

const QA_UNLIMITED_USAGE = true;
const FREE_GENERATION_LIMIT = 1;
const FREE_USAGE_STORAGE_KEY = "logrid-free-generation-count";
const AUTO_FRAME_LOGO_MAX_HEIGHT = 520;
const AUTO_FRAME_LOGO_HORIZONTAL_PADDING = 160;
const MAX_CONSTRUCTION_LINES = 8;
const OUTPUT_COORDINATE_ORIGIN: Rect = { x: 0, y: 0, width: 0, height: 0 };
let lastSourceNodeIds: string[] = [];
let lastContainerNodeId: string | null = null;
let isGenerating = false;
let pendingGenerationSettings: GenerationSettings | null = null;

figma.showUI(__html__, {
  width: 320,
  height: 720,
  themeColors: true,
});

figma.on("selectionchange", () => {
  void postState();
});

figma.ui.onmessage = (message: UiToPluginMessage) => {
  if (message.type === "init") {
    void postState();
  }

  if (message.type === "undo") {
    figma.triggerUndo();
    void postState();
  }

  if (message.type === "redo") {
    requestGenerate(message.settings);
  }

  if (message.type === "generate") {
    requestGenerate(message.settings);
  }

};

void postState();

function requestGenerate(settings: GenerationSettings) {
  pendingGenerationSettings = settings;

  if (!isGenerating) {
    void runGenerationQueue();
  }
}

async function runGenerationQueue() {
  isGenerating = true;

  while (pendingGenerationSettings) {
    const settings = pendingGenerationSettings;
    pendingGenerationSettings = null;
    await handleGenerate(settings);
  }

  isGenerating = false;
}

async function handleGenerate(settings: GenerationSettings) {
  if (figma.currentPage.selection.length === 0 && lastSourceNodeIds.length === 0) {
    postGenerationError("Select a background frame before generating.");
    return;
  }

  const usageBeforeGeneration = await ensureGenerationAccess();
  if (!usageBeforeGeneration.canGenerate) {
    postGenerationError("Your free generation has been used. Upgrade to Pro to continue.");
    return;
  }

  try {
    figma.commitUndo();
    const result = await generateFromSelection(settings);

    await consumeFreeGenerationIfNeeded(usageBeforeGeneration);
    const updatedUsage = await getUsageState();
    postToUi({
      type: "generation-complete",
      groupName: result.group.name,
      appliedSettings: result.settings,
      usage: updatedUsage,
    });
  } catch (error) {
    postGenerationError(error instanceof Error ? error.message : "Generation failed.");
  }
}

function postGenerationError(message: string) {
  figma.notify(message);
  postToUi({
    type: "generation-error",
    message,
  });
}

async function postState() {
  const generatedSelection = hasGeneratedSelection();

  postToUi({
    type: "state",
    selectionCount: figma.currentPage.selection.length,
    hasSelection: figma.currentPage.selection.length > 0,
    hasGeneratedOutput: lastSourceNodeIds.length > 0 || generatedSelection,
    hasGeneratedSelection: generatedSelection,
    canUseCircles: await canUseCircleGuidesForCurrentSelection(),
    usage: await getUsageState(),
  });
}

async function canUseCircleGuidesForCurrentSelection(): Promise<boolean> {
  if (figma.currentPage.selection.length === 0 && lastSourceNodeIds.length === 0) {
    return false;
  }

  const generatedSelection = figma.currentPage.selection.map(findGeneratedAncestor).find(isSceneNode);
  if (generatedSelection) {
    const storedValue = generatedSelection.getPluginData("canUseCircles");
    if (storedValue === "true" || storedValue === "false") {
      return storedValue === "true";
    }
  }

  try {
    const context = await getGenerationContext([...figma.currentPage.selection]);
    const absoluteLogoBounds = getSelectionBounds(context.logoNodes);
    const autoFrameBounds = context.container ? null : createAutoFrameBounds(absoluteLogoBounds);
    const coordinateOrigin = context.container ? getSelectionBounds([context.container]) : {
      x: absoluteLogoBounds.x - ((autoFrameBounds?.width ?? absoluteLogoBounds.width) - absoluteLogoBounds.width) / 2,
      y: absoluteLogoBounds.y - ((autoFrameBounds?.height ?? absoluteLogoBounds.height) - absoluteLogoBounds.height) / 2,
      width: autoFrameBounds?.width ?? 0,
      height: autoFrameBounds?.height ?? 0,
    };
    const logoBounds = toLocalRect(absoluteLogoBounds, coordinateOrigin);
    const canvasBounds = context.container ? { x: 0, y: 0, width: context.container.width, height: context.container.height } : autoFrameBounds ?? absoluteLogoBounds;
    const anchors = collectVectorAnchorPoints(context.logoNodes, coordinateOrigin, IDENTITY_GEOMETRY_TRANSFORM);
    const circularGuides = selectSymbolCircularGuides(collectCircularGuides(context.logoNodes, coordinateOrigin, canvasBounds, IDENTITY_GEOMETRY_TRANSFORM), logoBounds, anchors);
    return isLikelySymbolWithCircularGuides(logoBounds, circularGuides);
  } catch {
    return false;
  }
}

async function getUsageState(): Promise<UsageState> {
  if (QA_UNLIMITED_USAGE) {
    return {
      paymentStatus: "qa",
      freeLimit: Number.POSITIVE_INFINITY,
      freeUsed: 0,
      canGenerate: true,
    };
  }

  const paymentStatus = readPaymentStatus();
  const freeUsed = await readFreeUsageCount();

  return {
    paymentStatus,
    freeLimit: FREE_GENERATION_LIMIT,
    freeUsed,
    canGenerate: paymentStatus === "paid" || freeUsed < FREE_GENERATION_LIMIT,
  };
}

function readPaymentStatus(): UsageState["paymentStatus"] {
  const payments = getPaymentsApi();
  if (!payments) {
    return "not-supported";
  }

  try {
    switch (payments.status.type) {
      case "PAID":
        return "paid";
      case "UNPAID":
        return "unpaid";
      default:
        return "not-supported";
    }
  } catch {
    return "not-supported";
  }
}

async function ensureGenerationAccess(): Promise<UsageState> {
  const usage = await getUsageState();
  if (usage.canGenerate || usage.paymentStatus !== "unpaid") {
    return usage;
  }

  const payments = getPaymentsApi();
  if (!payments) {
    return usage;
  }

  try {
    await payments.initiateCheckoutAsync({ interstitial: "TRIAL_ENDED" });
  } catch {
    figma.notify("Checkout could not be started. Please try again.");
    return usage;
  }

  return getUsageState();
}

async function consumeFreeGenerationIfNeeded(usageBeforeGeneration: UsageState) {
  if (QA_UNLIMITED_USAGE || usageBeforeGeneration.paymentStatus !== "unpaid" || usageBeforeGeneration.freeUsed >= FREE_GENERATION_LIMIT) {
    return;
  }

  await figma.clientStorage.setAsync(FREE_USAGE_STORAGE_KEY, usageBeforeGeneration.freeUsed + 1);
}

async function readFreeUsageCount(): Promise<number> {
  const storedValue = await figma.clientStorage.getAsync(FREE_USAGE_STORAGE_KEY);
  return typeof storedValue === "number" && Number.isFinite(storedValue) ? Math.max(0, Math.floor(storedValue)) : 0;
}

function getPaymentsApi(): FigmaPaymentsApi | null {
  const payments = (figma as unknown as { payments?: Partial<FigmaPaymentsApi> }).payments;
  if (!payments || !payments.status || typeof payments.initiateCheckoutAsync !== "function") {
    return null;
  }

  return payments as FigmaPaymentsApi;
}

async function generateFromSelection(settings: GenerationSettings): Promise<GenerationResult> {
  const safeSettings = sanitizeGenerationSettings(settings);
  const context = await getGenerationContext([...figma.currentPage.selection]);
  const autoPalettes = context.autoPalettes ?? buildAutoPalettes(context.logoNodes);
  const effectiveSettings = applyAutoPalette(safeSettings, autoPalettes);
  const absoluteLogoBounds = getSelectionBounds(context.logoNodes);
  const autoFrameBounds = context.container ? null : createAutoFrameBounds(absoluteLogoBounds);
  const coordinateOrigin = context.container ? getSelectionBounds([context.container]) : {
    x: absoluteLogoBounds.x - ((autoFrameBounds?.width ?? absoluteLogoBounds.width) - absoluteLogoBounds.width) / 2,
    y: absoluteLogoBounds.y - ((autoFrameBounds?.height ?? absoluteLogoBounds.height) - absoluteLogoBounds.height) / 2,
    width: autoFrameBounds?.width ?? 0,
    height: autoFrameBounds?.height ?? 0,
  };
  const logoBounds = toLocalRect(absoluteLogoBounds, coordinateOrigin);
  const canvasBounds = context.container ? { x: 0, y: 0, width: context.container.width, height: context.container.height } : autoFrameBounds ?? absoluteLogoBounds;
  const geometryTransform = context.container ? resolveLogoGridFitTransform(logoBounds, canvasBounds, effectiveSettings) : resolveAutoFrameLogoTransform(logoBounds, canvasBounds);
  const timestamp = formatTimestamp(new Date());
  const logoLayerName = sourceLogoLayerName(context.logoNodes);
  const groupName = `${logoLayerName} - Logrid - ${capitalize(effectiveSettings.canvasPreset)} - ${capitalize(effectiveSettings.mode)} - ${timestamp}`;
  const generatedNodes: SceneNode[] = [];
  const analysisContext = createLogoAnalysisContext(context.logoNodes, coordinateOrigin, geometryTransform);
  let canUseCirclesForLogo = false;

  try {
    generatedNodes.push(createCanvasBackground(canvasBounds, effectiveSettings));
    if (effectiveSettings.mode === "construction" && effectiveSettings.gridEnabled) {
      generatedNodes.push(await createCanvasGrid(canvasBounds, effectiveSettings));
    }

    if (effectiveSettings.mode === "construction") {
      const constructionLines = await createConstructionLinesGroup(analysisContext.nodes, OUTPUT_COORDINATE_ORIGIN, canvasBounds, IDENTITY_GEOMETRY_TRANSFORM, effectiveSettings);
      if (constructionLines) {
        generatedNodes.push(constructionLines);
      }
    }

    if (effectiveSettings.logoVisible) {
      generatedNodes.push(...cloneLogoAnalysisNodesForDisplay(analysisContext.nodes, effectiveSettings));
    }

    if (effectiveSettings.mode === "construction") {
      const outputLogoBounds = transformRectBounds(logoBounds, geometryTransform);
      const guideResult = await createConstructionGuides(outputLogoBounds, canvasBounds, analysisContext.nodes, OUTPUT_COORDINATE_ORIGIN, IDENTITY_GEOMETRY_TRANSFORM, effectiveSettings);
      canUseCirclesForLogo = guideResult.canUseCircles;
      generatedNodes.push(...guideResult.nodes);
    }

    if (effectiveSettings.mode === "clearspace") {
      generatedNodes.push(...(await createClearspaceGuides(logoBounds, effectiveSettings)));
    }
  } finally {
    analysisContext.cleanup();
  }

  const group = createGeneratedFrame(generatedNodes, canvasBounds, groupName);
  group.setPluginData("pluginGenerated", "true");
  group.setPluginData("generatorVersion", "0.1.0");
  group.setPluginData("mode", effectiveSettings.mode);
  group.setPluginData("sourceNodeIds", JSON.stringify(context.logoNodes.map((node) => node.id)));
  group.setPluginData("containerNodeId", context.container?.id ?? "");
  group.setPluginData("canvasPreset", effectiveSettings.canvasPreset);
  group.setPluginData("autoPalettes", JSON.stringify(autoPalettes));
  group.setPluginData("canUseCircles", String(canUseCirclesForLogo));
  group.setPluginData("createdAt", new Date().toISOString());
  group.setPluginData("lockedByDefault", String(effectiveSettings.lockGuidelines));
  if (!context.container && autoFrameBounds) {
    group.x = coordinateOrigin.x;
    group.y = coordinateOrigin.y;
  }
  lastSourceNodeIds = context.logoNodes.map((node) => node.id);
  lastContainerNodeId = context.container?.id ?? null;
  placeGeneratedGroup(group, context);
  setSourceNodesVisible(context.logoNodes, false);

  if (effectiveSettings.replacePrevious) {
    await removePreviousGeneratedGroups({ exceptId: group.id, restoreSources: false });
    figma.currentPage.selection = [group];
  } else {
    figma.currentPage.selection = [group];
    figma.viewport.scrollAndZoomIntoView([group]);
  }

  return {
    group,
    settings: effectiveSettings,
  };
}

function createGeneratedFrame(nodes: readonly SceneNode[], bounds: Rect, name: string): FrameNode {
  const frame = figma.createFrame();
  frame.name = name;
  frame.x = bounds.x;
  frame.y = bounds.y;
  frame.resize(bounds.width, bounds.height);
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  frame.locked = false;

  for (const node of nodes) {
    frame.appendChild(node);
  }

  return frame;
}

function sanitizeGenerationSettings(settings: GenerationSettings): GenerationSettings {
  return {
    ...settings,
    backgroundColor: normalizeUiHex(settings.backgroundColor),
    backgroundOpacity: clampOpacity(settings.backgroundOpacity),
    gridStyle: settings.gridStyle === "dots" ? "dots" : "lines",
    gridColor: normalizeUiHex(settings.gridColor),
    gridOpacity: clampOpacity(settings.gridOpacity),
    logoOutlineColor: normalizeUiHex(settings.logoOutlineColor),
    logoOutlineOpacity: clampOpacity(settings.logoOutlineOpacity),
    logoFillColor: normalizeUiHex(settings.logoFillColor),
    logoFillOpacity: clampOpacity(settings.logoFillOpacity),
    guideColor: normalizeUiHex(settings.guideColor),
    guideOpacity: clampOpacity(settings.guideOpacity),
    strokeWidth: clampFinite(settings.strokeWidth, 0.1, 5, 0.6),
    gridSize: clampFinite(settings.gridSize, 0.1, 1, 1),
    anchorColor: normalizeUiHex(settings.anchorColor),
    anchorOpacity: clampOpacity(settings.anchorOpacity),
    anchorSize: clampFinite(settings.anchorSize, 0.1, 2, 0.5),
    handleColor: normalizeUiHex(settings.handleColor),
    handleOpacity: clampOpacity(settings.handleOpacity),
    handleLineWeight: clampFinite(settings.handleLineWeight, 0.1, 2, 0.5),
    handleLength: clampFinite(settings.handleLength, 0.1, 2, 1),
    handleSize: clampFinite(settings.handleSize, 0.1, 2, 0.5),
    colorOverrides: sanitizeColorOverrides(settings.colorOverrides),
    clearspaceValue: clampFinite(settings.clearspaceValue, 0, 1000, 60),
  };
}

function applyAutoPalette(settings: GenerationSettings, palettes: AutoPalettes): GenerationSettings {
  const overrides = new Set(settings.colorOverrides ?? []);
  const palette = palettes[settings.canvasPreset];

  return {
    ...settings,
    backgroundColor: overrides.has("backgroundColor") ? settings.backgroundColor : palette.backgroundColor,
    backgroundOpacity: overrides.has("backgroundOpacity") ? settings.backgroundOpacity : palette.backgroundOpacity,
    gridColor: overrides.has("gridColor") ? settings.gridColor : palette.gridColor,
    logoFillColor: overrides.has("logoFillColor") ? settings.logoFillColor : palette.logoFillColor,
    logoOutlineColor: overrides.has("logoOutlineColor") ? settings.logoOutlineColor : palette.logoOutlineColor,
    guideColor: overrides.has("guideColor") ? settings.guideColor : palette.guideColor,
    anchorColor: overrides.has("anchorColor") ? settings.anchorColor : palette.anchorColor,
    handleColor: overrides.has("handleColor") ? settings.handleColor : palette.handleColor,
  };
}

function sanitizeColorOverrides(value: GenerationSettings["colorOverrides"]): GenerationSettings["colorOverrides"] {
  const validKeys = new Set([
    "backgroundColor",
    "backgroundOpacity",
    "gridColor",
    "logoOutlineColor",
    "logoFillColor",
    "guideColor",
    "anchorColor",
    "handleColor",
  ]);

  return Array.isArray(value) ? value.filter((key) => validKeys.has(key)) : [];
}

function buildAutoPalettes(logoNodes: readonly SceneNode[]): AutoPalettes {
  const brandColor = chooseLogoColor(collectLogoSolidColors(logoNodes));
  if (!brandColor) {
    return createNeutralAutoPalettes(false);
  }

  const luminance = relativeLuminance(brandColor);
  const hsl = rgbToHsl(brandColor);
  const isNeutral = hsl.s < 0.12;

  if (isNeutral) {
    return createNeutralAutoPalettes(luminance < 0.45);
  }

  return {
    dark: {
      backgroundColor: hslToHex(hsl.h, clamp(hsl.s * 0.52, 0.24, 0.46), 0.08),
      backgroundOpacity: 1,
      gridColor: hslToHex(hsl.h, clamp(hsl.s * 0.45, 0.24, 0.42), 0.36),
      logoFillColor: hslToHex(hsl.h, clamp(hsl.s * 0.25, 0.08, 0.24), 0.62),
      logoOutlineColor: hslToHex(hsl.h, clamp(hsl.s * 0.34, 0.16, 0.36), 0.76),
      guideColor: hslToHex(hsl.h, clamp(hsl.s * 0.9, 0.44, 0.82), 0.68),
      anchorColor: hslToHex((hsl.h + 18) % 360, clamp(hsl.s, 0.42, 0.86), 0.78),
      handleColor: hslToHex(hsl.h, clamp(hsl.s * 0.75, 0.34, 0.72), 0.72),
    },
    light: {
      backgroundColor: hslToHex(hsl.h, clamp(hsl.s * 0.18, 0.04, 0.12), 0.94),
      backgroundOpacity: 1,
      gridColor: hslToHex(hsl.h, clamp(hsl.s * 0.22, 0.08, 0.18), 0.78),
      logoFillColor: hslToHex(hsl.h, clamp(hsl.s * 0.25, 0.08, 0.22), 0.45),
      logoOutlineColor: hslToHex(hsl.h, clamp(hsl.s * 0.42, 0.18, 0.42), 0.34),
      guideColor: hslToHex(hsl.h, clamp(hsl.s * 0.85, 0.42, 0.78), 0.42),
      anchorColor: hslToHex((hsl.h + 18) % 360, clamp(hsl.s, 0.42, 0.86), 0.36),
      handleColor: hslToHex(hsl.h, clamp(hsl.s * 0.74, 0.34, 0.72), 0.42),
    },
  };
}

function createNeutralAutoPalettes(preferLightContrast: boolean): AutoPalettes {
  return {
    dark: {
      backgroundColor: "#141414",
      backgroundOpacity: 1,
      gridColor: "#3A3A3A",
      logoFillColor: preferLightContrast ? "#A1A1AA" : "#737373",
      logoOutlineColor: "#E4E4E7",
      guideColor: "#D4D4D8",
      anchorColor: "#F5F5F5",
      handleColor: "#D4D4D8",
    },
    light: {
      backgroundColor: "#F2F2ED",
      backgroundOpacity: 1,
      gridColor: "#D5D5CF",
      logoFillColor: preferLightContrast ? "#62626A" : "#767676",
      logoOutlineColor: "#4B5563",
      guideColor: "#333333",
      anchorColor: "#111827",
      handleColor: "#4B5563",
    },
  };
}

function collectLogoSolidColors(nodes: readonly SceneNode[]): RgbColor[] {
  const colors: RgbColor[] = [];

  for (const node of nodes) {
    if (!isStructuralLogoPreviewNode(node)) {
      colors.push(...getSolidPaintColors(node));
    }

    if ("children" in node) {
      colors.push(...collectLogoSolidColors([...node.children].filter(isSceneNode)));
    }
  }

  return colors;
}

function getSolidPaintColors(node: SceneNode): RgbColor[] {
  const paints: Paint[] = [];

  if ("fills" in node && Array.isArray(node.fills)) {
    paints.push(...node.fills);
  }

  if ("strokes" in node && Array.isArray(node.strokes)) {
    paints.push(...node.strokes);
  }

  return paints
    .filter((paint): paint is SolidPaint => paint.type === "SOLID" && paint.visible !== false && (paint.opacity ?? 1) > 0.05)
    .map((paint) => ({
      r: paint.color.r * 255,
      g: paint.color.g * 255,
      b: paint.color.b * 255,
    }));
}

function chooseLogoColor(colors: RgbColor[]): RgbColor | null {
  let best: { color: RgbColor; score: number } | null = null;

  for (const color of colors) {
    const hsl = rgbToHsl(color);
    const luminance = relativeLuminance(color);
    if (luminance > 0.96) {
      continue;
    }

    const midtoneScore = 1 - Math.abs(luminance - 0.46);
    const score = hsl.s * 1.8 + midtoneScore * 0.55 + (luminance < 0.08 ? -0.2 : 0);
    if (!best || score > best.score) {
      best = { color, score };
    }
  }

  return best?.color ?? colors[0] ?? null;
}

async function getGenerationContext(selection: readonly SceneNode[]): Promise<GenerationContext> {
  const generatedSelection = selection.map(findGeneratedAncestor).find(isSceneNode);
  if (generatedSelection) {
    const generatedContext = await getSourceContextFromGeneratedNode(generatedSelection, await getStoredContainer(generatedSelection));
    if (generatedContext) {
      return generatedContext;
    }
  }

  const nonGeneratedSelection = selection.filter((node) => !isGeneratedNode(node));
  if (nonGeneratedSelection.length > 0) {
    const selectedContainer = nonGeneratedSelection.find(isCanvasContainerNode);
    if (selectedContainer) {
      const generatedChild = findGeneratedDescendant(selectedContainer);
      const generatedContext = generatedChild ? await getSourceContextFromGeneratedNode(generatedChild, selectedContainer) : null;
      if (generatedContext) {
        lastSourceNodeIds = generatedContext.logoNodes.map((node) => node.id);
        lastContainerNodeId = selectedContainer.id;
        return generatedContext;
      }

      const lastSourceNodes = (await getNodesByIds(lastSourceNodeIds)).filter(isSceneNode);
      if (selectedContainer.id === lastContainerNodeId && lastSourceNodes.length > 0) {
        return {
          container: selectedContainer,
          logoNodes: lastSourceNodes,
        };
      }

      const logoNodes = findLogoNodesInContainer(selectedContainer);
      lastSourceNodeIds = logoNodes.map((node) => node.id);
      lastContainerNodeId = selectedContainer.id;
      return {
        container: selectedContainer,
        logoNodes,
      };
    }

    lastSourceNodeIds = nonGeneratedSelection.map((node) => node.id);
    lastContainerNodeId = nonGeneratedSelection[0]?.parent && isSceneNode(nonGeneratedSelection[0].parent) ? nonGeneratedSelection[0].parent.id : null;
    return {
      container: null,
      logoNodes: nonGeneratedSelection,
    };
  }

  const lastSourceNodes = (await getNodesByIds(lastSourceNodeIds)).filter(isSceneNode);
  if (lastSourceNodes.length > 0) {
    const container = lastContainerNodeId ? await figma.getNodeByIdAsync(lastContainerNodeId) : null;
    return {
      container: isContainerNode(container) ? container : null,
      logoNodes: lastSourceNodes,
    };
  }

  throw new Error("Select a background frame that contains a logo.");
}

async function getSourceContextFromGeneratedNode(generatedNode: SceneNode, container: ContainerNode | null): Promise<GenerationContext | null> {
  const sourceNodeIds = parseSourceNodeIds(generatedNode.getPluginData("sourceNodeIds"));
  const sourceNodes = (await getNodesByIds(sourceNodeIds)).filter(isSceneNode);
  if (sourceNodes.length === 0) {
    return null;
  }

  return {
    container,
    logoNodes: sourceNodes,
    autoPalettes: parseAutoPalettes(generatedNode.getPluginData("autoPalettes")),
  };
}

async function getNodesByIds(ids: readonly string[]): Promise<Array<BaseNode | null>> {
  return Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)));
}

function findGeneratedDescendant(container: ContainerNode): SceneNode | null {
  for (const child of container.children) {
    if (!isSceneNode(child)) {
      continue;
    }

    if (isGeneratedNode(child)) {
      return child;
    }

    if ("children" in child) {
      const nested = findGeneratedDescendant(child);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function hasGeneratedSelection(): boolean {
  return figma.currentPage.selection.some((node) => Boolean(findGeneratedAncestor(node)) || (isContainerNode(node) && Boolean(findGeneratedDescendant(node))));
}

function findGeneratedAncestor(node: SceneNode): SceneNode | null {
  let current: BaseNode | null = node;

  while (current) {
    if (isSceneNode(current) && isGeneratedNode(current)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

function isGeneratedNode(node: SceneNode): boolean {
  return "getPluginData" in node && node.getPluginData("pluginGenerated") === "true";
}

function sourceLogoLayerName(logoNodes: readonly SceneNode[]): string {
  if (logoNodes.length === 1) {
    return sanitizeLayerName(logoNodes[0].name);
  }

  const sharedParent = logoNodes[0]?.parent;
  if (sharedParent && logoNodes.every((node) => node.parent?.id === sharedParent.id) && sharedParent.type !== "PAGE") {
    return sanitizeLayerName(sharedParent.name);
  }

  return sanitizeLayerName(logoNodes[0]?.name ?? "Logo");
}

function sanitizeLayerName(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : "Logo";
}

function parseSourceNodeIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseAutoPalettes(value: string): AutoPalettes | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<Record<GenerationSettings["canvasPreset"], Partial<AutoPalette>>>;
    if (isAutoPalette(parsed.dark) && isAutoPalette(parsed.light)) {
      return {
        dark: parsed.dark,
        light: parsed.light,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isAutoPalette(value: Partial<AutoPalette> | undefined): value is AutoPalette {
  return Boolean(
    value &&
      typeof value.backgroundColor === "string" &&
      typeof value.backgroundOpacity === "number" &&
      typeof value.gridColor === "string" &&
      typeof value.logoFillColor === "string" &&
      typeof value.logoOutlineColor === "string" &&
      typeof value.guideColor === "string" &&
      typeof value.anchorColor === "string" &&
      typeof value.handleColor === "string",
  );
}

function isSceneNode(node: BaseNode | null): node is SceneNode {
  return Boolean(node && "visible" in node && "removed" in node);
}

async function getStoredContainer(node: SceneNode): Promise<ContainerNode | null> {
  const containerNodeId = node.getPluginData("containerNodeId");
  if (!containerNodeId) {
    return null;
  }

  const container = await figma.getNodeByIdAsync(containerNodeId);
  return isContainerNode(container) ? container : null;
}

function isContainerNode(node: BaseNode | null): node is ContainerNode {
  return Boolean(node && "children" in node && (node.type === "FRAME" || node.type === "GROUP" || node.type === "COMPONENT" || node.type === "INSTANCE"));
}

function isCanvasContainerNode(node: BaseNode | null): node is ContainerNode {
  if (!isContainerNode(node) || node.type !== "FRAME" || !node.absoluteBoundingBox) {
    return false;
  }

  const box = node.absoluteBoundingBox;
  return box.width >= 640 && box.height >= 360;
}

function findLogoNodesInContainer(container: ContainerNode): SceneNode[] {
  const containerBox = container.absoluteBoundingBox;
  const directChildren = [...container.children].filter((child) => isSceneNode(child) && child.visible && !isGeneratedNode(child));
  const candidates = directChildren.filter((child) => !isLikelyBackgroundChild(child, containerBox));

  if (candidates.length > 0) {
    return candidates;
  }

  return directChildren.length > 0 ? directChildren : [container];
}

function isLikelyBackgroundChild(node: SceneNode, containerBox: Rect | null): boolean {
  if (!containerBox || !("absoluteBoundingBox" in node) || !node.absoluteBoundingBox) {
    return false;
  }

  const box = node.absoluteBoundingBox;
  const areaRatio = (box.width * box.height) / Math.max(1, containerBox.width * containerBox.height);
  const coversContainer = areaRatio > 0.72 && Math.abs(box.width - containerBox.width) < 4 && Math.abs(box.height - containerBox.height) < 4;
  return coversContainer && (node.type === "RECTANGLE" || node.type === "FRAME");
}

function createCanvasBackground(bounds: Rect, settings: GenerationSettings): RectangleNode {
  const background = figma.createRectangle();
  background.name = "Canvas Background";
  background.x = bounds.x;
  background.y = bounds.y;
  background.resize(bounds.width, bounds.height);
  background.fills = [solidPaint(settings.backgroundColor, settings.backgroundOpacity)];
  background.strokes = [];
  background.locked = settings.lockGuidelines;
  return background;
}

function createLogoAnalysisContext(logoNodes: readonly SceneNode[], coordinateOrigin: Rect, geometryTransform: GeometryTransform): LogoAnalysisContext {
  const clones = logoNodes.map((node) => {
    const clone = node.clone();
    clone.name = `Logo Analysis - ${node.name}`;
    figma.currentPage.appendChild(clone);
    clone.relativeTransform = transformToOutputSpace(node.absoluteTransform, coordinateOrigin, geometryTransform);

    if (geometryTransform.scale !== 1 && "rescale" in clone) {
      clone.rescale(geometryTransform.scale);
    }

    return clone;
  });

  try {
    const outline = figma.flatten(clones, figma.currentPage);
    outline.name = "Logo Analysis Outline";
    return {
      nodes: [outline],
      cleanup: () => {
        if (!outline.removed) {
          outline.remove();
        }
      },
    };
  } catch {
    return {
      nodes: clones,
      cleanup: () => {
        for (const clone of clones) {
          if (!clone.removed) {
            clone.remove();
          }
        }
      },
    };
  }
}

function cloneLogoAnalysisNodesForDisplay(analysisNodes: readonly SceneNode[], settings: GenerationSettings): SceneNode[] {
  return analysisNodes.map((node) => {
    const clone = node.clone();
    clone.name = `Logo Preview - ${node.name.replace(/^Logo Analysis(?: Outline)?(?: - )?/, "") || "Logo"}`;
    figma.currentPage.appendChild(clone);
    styleLogoPreviewNode(clone, settings);
    clone.visible = true;
    clone.locked = settings.lockGuidelines;
    return clone;
  });
}

function styleLogoPreviewNode(node: SceneNode, settings: GenerationSettings) {
  if ("opacity" in node) {
    node.opacity = 1;
  }

  if (isStructuralLogoPreviewNode(node)) {
    if ("fills" in node && node.fills !== figma.mixed) {
      node.fills = [];
    }

    if ("strokes" in node) {
      node.strokes = [];
    }
  } else {
    if ("fills" in node && node.fills !== figma.mixed) {
      node.fills = settings.logoStyle === "fill" ? [solidPaint(settings.logoFillColor, settings.logoFillOpacity)] : [];
    }

    if ("strokes" in node) {
      node.strokes = [solidPaint(settings.logoOutlineColor, settings.logoOutlineOpacity)];
      node.strokeWeight = Math.max(0.75, settings.strokeWidth);
    }
  }

  if ("children" in node) {
    for (const child of node.children) {
      if (isSceneNode(child)) {
        styleLogoPreviewNode(child, settings);
      }
    }
  }
}

function isStructuralLogoPreviewNode(node: SceneNode): boolean {
  return node.type === "FRAME" || node.type === "GROUP" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "SECTION";
}

function setSourceNodesVisible(nodes: readonly SceneNode[], visible: boolean) {
  for (const node of nodes) {
    if (!node.getPluginData("brandGridOriginalVisible")) {
      node.setPluginData("brandGridOriginalVisible", String(node.visible));
    }
    node.visible = visible;
  }
}

async function restoreSourceNodesVisibilityFromGroup(group: SceneNode) {
  const sourceNodeIds = parseSourceNodeIds(group.getPluginData("sourceNodeIds"));

  for (const id of sourceNodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (!isSceneNode(node)) {
      continue;
    }

    const originalVisible = node.getPluginData("brandGridOriginalVisible");
    if (originalVisible) {
      node.visible = originalVisible === "true";
      node.setPluginData("brandGridOriginalVisible", "");
    }
  }
}

async function createConstructionGuides(
  logoBounds: Rect,
  canvasBounds: Rect,
  logoNodes: readonly SceneNode[],
  coordinateOrigin: Rect,
  geometryTransform: GeometryTransform,
  settings: GenerationSettings,
): Promise<{ nodes: SceneNode[]; canUseCircles: boolean }> {
  const nodes: SceneNode[] = [];
  const outputLogoBounds = transformRectBounds(logoBounds, geometryTransform);
  const canGenerateCircles = settings.constructionElements.includes("circles");
  const allAnchors = collectVectorAnchorPoints(logoNodes, coordinateOrigin, geometryTransform);
  const rawCircularGuides = collectCircularGuides(logoNodes, coordinateOrigin, canvasBounds, geometryTransform);
  const circularGuides = selectSymbolCircularGuides(rawCircularGuides, outputLogoBounds, allAnchors);
  const canUseCircles = isLikelySymbolWithCircularGuides(outputLogoBounds, circularGuides);
  const shouldGenerateCircles = canGenerateCircles && canUseCircles;
  const angleAnchors = selectKeyAnchorPoints(allAnchors, 3);

  if (shouldGenerateCircles) {
    const circles = createConstructionCircles(circularGuides, settings);
    if (circles.length > 0) {
      const group = figma.group(circles, figma.currentPage);
      group.name = "Construction Circles";
      group.locked = settings.lockGuidelines;
      nodes.push(group);
    }
  }

  if (settings.constructionElements.includes("anchors")) {
    const anchors = createAnchorPoints(allAnchors, canvasBounds, settings);
    if (anchors.length > 0) {
      const group = figma.group(anchors, figma.currentPage);
      group.name = "Anchors";
      group.locked = settings.lockGuidelines;
      nodes.push(group);
    }
  }

  if (settings.constructionElements.includes("handles")) {
    const handles = createHandleGuides(logoNodes, coordinateOrigin, canvasBounds, geometryTransform, settings);
    if (handles.length > 0) {
      const group = figma.group(handles, figma.currentPage);
      group.name = "Handles";
      group.locked = settings.lockGuidelines;
      nodes.push(group);
    }
  }

  if (settings.constructionElements.includes("angles")) {
    const angleGuides = await createAngleGuides(logoNodes, coordinateOrigin, geometryTransform, angleAnchors, outputLogoBounds, settings);
    if (angleGuides.length > 0) {
      const group = figma.group(angleGuides, figma.currentPage);
      group.name = "Angle Guides";
      group.locked = settings.lockGuidelines;
      nodes.push(group);
    }
  }

  return { nodes, canUseCircles };
}

function isLikelySymbolWithCircularGuides(bounds: Rect, circularGuides: readonly CircleGuide[]): boolean {
  if (bounds.width <= 0 || bounds.height <= 0 || circularGuides.length === 0) {
    return false;
  }

  const aspectRatio = Math.max(bounds.width, bounds.height) / Math.min(bounds.width, bounds.height);
  return aspectRatio <= 2.05 || hasStrongCircularEvidence(circularGuides, bounds);
}

function hasStrongCircularEvidence(circularGuides: readonly CircleGuide[], bounds: Rect): boolean {
  const minDimension = Math.min(bounds.width, bounds.height);
  const aspectRatio = Math.max(bounds.width, bounds.height) / Math.min(bounds.width, bounds.height);
  const maxUsefulRadius = aspectRatio > 2.05 ? minDimension * 0.24 : minDimension * 0.72;

  return circularGuides.some((circle) => {
    const relativeError = circle.error / Math.max(1, circle.radius);
    const effectiveMaxRadius = circle.source === "loop" ? Math.min(maxUsefulRadius, minDimension * 0.26) : maxUsefulRadius;
    const usefulLogoScale = circle.radius >= minDimension * 0.045 && circle.radius <= effectiveMaxRadius;
    return usefulLogoScale && circle.arcAngle >= 34 && relativeError <= 0.045;
  });
}

function selectSymbolCircularGuides(circularGuides: readonly CircleGuide[], bounds: Rect, anchors: readonly Point[] = []): CircleGuide[] {
  if (bounds.width <= 0 || bounds.height <= 0) {
    return [];
  }

  const minDimension = Math.min(bounds.width, bounds.height);
  const maxDimension = Math.max(bounds.width, bounds.height);
  const aspectRatio = maxDimension / minDimension;
  const isLogotype = aspectRatio > 2.05;
  const boundsCenter = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };

  const filtered = circularGuides.filter((circle) => {
    const centerDistance = distance(circle.center, boundsCenter);
    const maxRadius = circle.source === "loop" ? minDimension * 0.26 : isLogotype ? minDimension * 0.24 : maxDimension * 1.35;
    const minRadius = minDimension * 0.045;
    const isUsefulRadius = circle.radius >= minRadius && circle.radius <= maxRadius;
    const isNearLogo = isLogotype ? isPointInsideExpandedRect(circle.center, bounds, minDimension * 0.12) : centerDistance <= maxDimension * 0.95;
    const coversMeaningfulArc = circle.arcAngle >= (isLogotype ? 28 : 12);
    return isRoundCircleGuide(circle) && isUsefulRadius && isNearLogo && coversMeaningfulArc && hasCircleAnchorSupport(circle, anchors);
  });

  return dedupeCircularGuides(filtered)
    .sort((a, b) => scoreCircularGuideForSelection(b, minDimension, isLogotype) - scoreCircularGuideForSelection(a, minDimension, isLogotype))
    .slice(0, isLogotype ? 4 : 12);
}

function isRoundCircleGuide(circle: CircleGuide): boolean {
  const radiusX = circle.radiusX ?? circle.radius;
  const radiusY = circle.radiusY ?? circle.radius;
  const ratio = Math.max(radiusX, radiusY) / Math.max(1, Math.min(radiusX, radiusY));
  return ratio <= 1.08;
}

function hasCircleAnchorSupport(circle: CircleGuide, anchors: readonly Point[]): boolean {
  if (circle.source === "loop" || anchors.length === 0) {
    return true;
  }

  const tolerance = Math.max(3, circle.radius * 0.035);
  const supportedAnchors = anchors.filter((anchor) => Math.abs(distance(anchor, circle.center) - circle.radius) <= tolerance);
  return supportedAnchors.length >= 2;
}

function scoreCircularGuideForSelection(circle: CircleGuide, minDimension: number, isLogotype: boolean): number {
  if (!isLogotype) {
    return circle.score;
  }

  const radiusPenalty = circle.radius / Math.max(1, minDimension);
  return circle.score - radiusPenalty * 1.8;
}

function transformRectBounds(rect: Rect, transform: GeometryTransform): Rect {
  const points = [
    applyGeometryTransform({ x: rect.x, y: rect.y }, transform),
    applyGeometryTransform({ x: rect.x + rect.width, y: rect.y }, transform),
    applyGeometryTransform({ x: rect.x, y: rect.y + rect.height }, transform),
    applyGeometryTransform({ x: rect.x + rect.width, y: rect.y + rect.height }, transform),
  ];
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function isPointInsideExpandedRect(point: Point, rect: Rect, expansion: number): boolean {
  return (
    point.x >= rect.x - expansion &&
    point.x <= rect.x + rect.width + expansion &&
    point.y >= rect.y - expansion &&
    point.y <= rect.y + rect.height + expansion
  );
}

async function createCanvasGrid(bounds: Rect, settings: GenerationSettings): Promise<GroupNode> {
  const gridNodes = settings.gridStyle === "dots" ? createGridDots(bounds, settings) : await createGridLines(bounds, settings);
  const group = figma.group(gridNodes, figma.currentPage);
  group.name = settings.gridStyle === "dots" ? "Dot Grid" : "Square Grid";
  group.locked = settings.lockGuidelines;
  return group;
}

async function createClearspaceGuides(bounds: Rect, settings: GenerationSettings): Promise<SceneNode[]> {
  const clearspace = resolveClearspace(bounds, settings);
  const outer = figma.createRectangle();
  outer.name = "Exclusion Zone";
  outer.x = bounds.x - clearspace;
  outer.y = bounds.y - clearspace;
  outer.resize(bounds.width + clearspace * 2, bounds.height + clearspace * 2);
  outer.fills = [];
  outer.strokes = [solidPaint(settings.guideColor, settings.guideOpacity)];
  outer.strokeWeight = settings.strokeWidth;
  outer.locked = settings.lockGuidelines;

  const inner = figma.createRectangle();
  inner.name = "Logo Bounds";
  inner.x = bounds.x;
  inner.y = bounds.y;
  inner.resize(bounds.width, bounds.height);
  inner.fills = [];
  inner.strokes = [solidPaint("#71717A", 0.5)];
  inner.strokeWeight = 1;
  inner.dashPattern = [3, 3];
  inner.locked = settings.lockGuidelines;

  const guides = [
    await createLine("Top Space", bounds.x, bounds.y - clearspace, bounds.x, bounds.y, settings),
    await createLine("Right Space", bounds.x + bounds.width, bounds.y, bounds.x + bounds.width + clearspace, bounds.y, settings),
    await createLine("Bottom Space", bounds.x + bounds.width, bounds.y + bounds.height, bounds.x + bounds.width, bounds.y + bounds.height + clearspace, settings),
    await createLine("Left Space", bounds.x - clearspace, bounds.y + bounds.height, bounds.x, bounds.y + bounds.height, settings),
  ];

  const exclusionGroup = figma.group([outer, inner], figma.currentPage);
  exclusionGroup.name = "Exclusion Zone";
  exclusionGroup.locked = settings.lockGuidelines;

  const measurementGroup = figma.group(guides, figma.currentPage);
  measurementGroup.name = "Measurement Guides";
  measurementGroup.locked = settings.lockGuidelines;

  return [exclusionGroup, measurementGroup];
}

async function createLine(name: string, x1: number, y1: number, x2: number, y2: number, settings: GenerationSettings): Promise<VectorNode> {
  return createStyledLine(name, x1, y1, x2, y2, settings, {
    opacity: settings.guideOpacity,
    weight: settings.strokeWidth,
  });
}

async function createStyledLine(
  name: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  settings: GenerationSettings,
  style: { opacity: number; weight: number },
): Promise<VectorNode> {
  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const line = figma.createVector();
  line.name = name;
  line.x = minX;
  line.y = minY;
  await line.setVectorNetworkAsync({
    vertices: [
      { x: x1 - minX, y: y1 - minY },
      { x: x2 - minX, y: y2 - minY },
    ],
    segments: [{ start: 0, end: 1 }],
    regions: [],
  });
  line.strokes = [solidPaint(settings.guideColor, style.opacity)];
  line.strokeWeight = style.weight;
  line.dashPattern = settings.lineStyle === "dashed" ? [6, 4] : [];
  line.locked = settings.lockGuidelines;
  return line;
}

async function createConstructionLinesGroup(
  logoNodes: readonly SceneNode[],
  coordinateOrigin: Rect,
  canvasBounds: Rect,
  geometryTransform: GeometryTransform,
  settings: GenerationSettings,
): Promise<GroupNode | null> {
  const guides = collectSegmentConstructionLines(logoNodes, coordinateOrigin, canvasBounds, geometryTransform);
  if (guides.length === 0) {
    return null;
  }

  const lines = await Promise.all(
    guides.map((guide, index) =>
      createStyledLine(`Construction Line ${index + 1}`, guide.start.x, guide.start.y, guide.end.x, guide.end.y, settings, {
        opacity: settings.guideOpacity,
        weight: settings.strokeWidth,
      }),
    ),
  );

  for (const line of lines) {
    line.strokes = [solidPaint(settings.guideColor, settings.guideOpacity)];
  }

  const group = figma.group(lines, figma.currentPage);
  group.name = "Construction Lines";
  group.locked = settings.lockGuidelines;
  return group;
}

function collectSegmentConstructionLines(
  nodes: readonly SceneNode[],
  coordinateOrigin: Rect,
  canvasBounds: Rect,
  geometryTransform: GeometryTransform,
): LineGuide[] {
  const guides: LineGuide[] = [];

  for (const node of nodes) {
    if (node.type === "VECTOR") {
      guides.push(...vectorSegmentsToConstructionLines(node, coordinateOrigin, canvasBounds, geometryTransform));
      continue;
    }

    if ("children" in node) {
      guides.push(...collectSegmentConstructionLines([...node.children].filter(isSceneNode), coordinateOrigin, canvasBounds, geometryTransform));
    }
  }

  return selectConstructionLineGuides(dedupeLineGuides(guides), canvasBounds);
}

function vectorSegmentsToConstructionLines(
  node: VectorNode,
  coordinateOrigin: Rect,
  canvasBounds: Rect,
  geometryTransform: GeometryTransform,
): LineGuide[] {
  const guides: LineGuide[] = [];
  const vertices = node.vectorNetwork.vertices;

  for (const segment of node.vectorNetwork.segments) {
    const start = vertices[segment.start];
    const end = vertices[segment.end];
    if (!start || !end) {
      continue;
    }

    const startPoint = vectorLocalPointToOutputPoint(node, start.x, start.y, coordinateOrigin, geometryTransform);
    const endPoint = vectorLocalPointToOutputPoint(node, end.x, end.y, coordinateOrigin, geometryTransform);
    const curvedPoints = sampleCurvedSegmentPoints(node, segment, coordinateOrigin, geometryTransform);

    if (curvedPoints) {
      const circularGuide = fitCircleFromSampledArc(curvedPoints, canvasBounds);
      if (circularGuide && circularGuide.arcAngle >= 18) {
        continue;
      }

      if (!isNearlyStraightSegment(curvedPoints)) {
        continue;
      }
    }

    const direction = segmentDirection(startPoint, endPoint, segment, node, coordinateOrigin, geometryTransform);
    const clipped = clipInfiniteLineToRect(startPoint, direction, canvasBounds);
    const segmentLength = distance(startPoint, endPoint);

    if (clipped && segmentLength >= minimumConstructionSegmentLength(canvasBounds)) {
      guides.push({
        start: clipped.start,
        end: clipped.end,
        angle: normalizedLineAngle(direction),
        offset: normalizedLineOffset(startPoint, direction),
        score: scoreConstructionLine(segmentLength, direction),
      });
    }
  }

  return guides;
}

function selectConstructionLineGuides(guides: readonly LineGuide[], canvasBounds: Rect): LineGuide[] {
  const selected: LineGuide[] = [];
  const axisGuides = guides
    .filter((guide) => constructionLineKind(guide.angle) !== "diagonal")
    .sort((a, b) => b.score - a.score);
  const diagonalGuides = guides
    .filter((guide) => constructionLineKind(guide.angle) === "diagonal")
    .sort((a, b) => b.score - a.score);

  addConstructionLineGuides(selected, axisGuides, 6, canvasBounds);
  addConstructionLineGuides(selected, diagonalGuides, 2, canvasBounds);

  return selected.sort((a, b) => b.score - a.score).slice(0, MAX_CONSTRUCTION_LINES);
}

function addConstructionLineGuides(selected: LineGuide[], candidates: readonly LineGuide[], maxCount: number, canvasBounds: Rect) {
  let added = 0;

  for (const guide of candidates) {
    if (added >= maxCount || selected.length >= MAX_CONSTRUCTION_LINES) {
      return;
    }

    if (selected.some((existing) => areSimilarLineGuides(existing, guide, canvasBounds))) {
      continue;
    }

    selected.push(guide);
    added += 1;
  }
}

function scoreConstructionLine(segmentLength: number, direction: Point): number {
  const kind = constructionLineKind(normalizedLineAngle(direction));
  if (kind === "diagonal") {
    return segmentLength * 0.72;
  }

  return segmentLength * 1.2;
}

function minimumConstructionSegmentLength(canvasBounds: Rect): number {
  return Math.max(28, Math.min(canvasBounds.width, canvasBounds.height) * 0.035);
}

function constructionLineKind(angle: number): "horizontal" | "vertical" | "diagonal" {
  const horizontalDistance = Math.min(angle, Math.abs(Math.PI - angle));
  const verticalDistance = Math.abs(Math.PI / 2 - angle);
  const axisTolerance = degreesToRadians(3);

  if (horizontalDistance <= axisTolerance) {
    return "horizontal";
  }

  if (verticalDistance <= axisTolerance) {
    return "vertical";
  }

  return "diagonal";
}

function sampleCurvedSegmentPoints(
  node: VectorNode,
  segment: VectorSegment,
  coordinateOrigin: Rect,
  geometryTransform: GeometryTransform,
): Point[] | null {
  if (!segment.tangentStart || !segment.tangentEnd || !hasTangent(segment.tangentStart) || !hasTangent(segment.tangentEnd)) {
    return null;
  }

  const start = node.vectorNetwork.vertices[segment.start];
  const end = node.vectorNetwork.vertices[segment.end];
  if (!start || !end) {
    return null;
  }

  return sampleCubicBezierPoints(
    vectorLocalPointToOutputPoint(node, start.x, start.y, coordinateOrigin, geometryTransform),
    vectorLocalPointToOutputPoint(node, start.x + segment.tangentStart.x, start.y + segment.tangentStart.y, coordinateOrigin, geometryTransform),
    vectorLocalPointToOutputPoint(node, end.x + segment.tangentEnd.x, end.y + segment.tangentEnd.y, coordinateOrigin, geometryTransform),
    vectorLocalPointToOutputPoint(node, end.x, end.y, coordinateOrigin, geometryTransform),
    18,
  );
}

function isNearlyStraightSegment(points: readonly Point[]): boolean {
  if (points.length < 3) {
    return true;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const chordLength = distance(first, last);
  if (chordLength < 6) {
    return false;
  }

  const maxDeviation = Math.max(...points.map((point) => distancePointToLine(point, first, last)));
  return maxDeviation <= Math.max(1.2, chordLength * 0.018);
}

function distancePointToLine(point: Point, lineStart: Point, lineEnd: Point): number {
  const lineLength = distance(lineStart, lineEnd);
  if (lineLength < 0.0001) {
    return distance(point, lineStart);
  }

  return Math.abs((lineEnd.x - lineStart.x) * (lineStart.y - point.y) - (lineStart.x - point.x) * (lineEnd.y - lineStart.y)) / lineLength;
}

function segmentDirection(
  startPoint: Point,
  endPoint: Point,
  segment: VectorSegment,
  node: VectorNode,
  coordinateOrigin: Rect,
  geometryTransform: GeometryTransform,
): Point {
  if (segment.tangentStart && hasTangent(segment.tangentStart)) {
    const startVertex = node.vectorNetwork.vertices[segment.start];
    const control = vectorLocalPointToOutputPoint(
      node,
      startVertex.x + segment.tangentStart.x,
      startVertex.y + segment.tangentStart.y,
      coordinateOrigin,
      geometryTransform,
    );
    return normalizeVector({ x: control.x - startPoint.x, y: control.y - startPoint.y });
  }

  return normalizeVector({ x: endPoint.x - startPoint.x, y: endPoint.y - startPoint.y });
}

function clipInfiniteLineToRect(point: Point, direction: Point, rect: Rect): Pick<LineGuide, "start" | "end"> | null {
  const intersections: Array<{ point: Point; t: number }> = [];
  const minX = rect.x;
  const minY = rect.y;
  const maxX = rect.x + rect.width;
  const maxY = rect.y + rect.height;

  if (Math.abs(direction.x) > 0.0001) {
    addLineRectIntersection(intersections, point, direction, (minX - point.x) / direction.x, rect);
    addLineRectIntersection(intersections, point, direction, (maxX - point.x) / direction.x, rect);
  }

  if (Math.abs(direction.y) > 0.0001) {
    addLineRectIntersection(intersections, point, direction, (minY - point.y) / direction.y, rect);
    addLineRectIntersection(intersections, point, direction, (maxY - point.y) / direction.y, rect);
  }

  const unique = dedupeLineIntersections(intersections);
  if (unique.length < 2) {
    return null;
  }

  unique.sort((a, b) => a.t - b.t);
  return {
    start: unique[0].point,
    end: unique[unique.length - 1].point,
  };
}

function addLineRectIntersection(items: Array<{ point: Point; t: number }>, origin: Point, direction: Point, t: number, rect: Rect) {
  const point = {
    x: origin.x + direction.x * t,
    y: origin.y + direction.y * t,
  };
  const epsilon = 0.5;

  if (point.x >= rect.x - epsilon && point.x <= rect.x + rect.width + epsilon && point.y >= rect.y - epsilon && point.y <= rect.y + rect.height + epsilon) {
    items.push({ point, t });
  }
}

function dedupeLineIntersections(items: Array<{ point: Point; t: number }>): Array<{ point: Point; t: number }> {
  const result: Array<{ point: Point; t: number }> = [];

  for (const item of items) {
    if (!result.some((candidate) => distance(candidate.point, item.point) < 1)) {
      result.push(item);
    }
  }

  return result;
}

function dedupeLineGuides(guides: readonly LineGuide[]): LineGuide[] {
  const result: LineGuide[] = [];
  const fallbackBounds = { x: 0, y: 0, width: 1920, height: 1080 };

  for (const guide of [...guides].sort((a, b) => b.score - a.score)) {
    const duplicate = result.some((existing) => areSimilarLineGuides(existing, guide, fallbackBounds));
    if (!duplicate) {
      result.push(guide);
    }
  }

  return result;
}

function areSimilarLineGuides(first: LineGuide, second: LineGuide, bounds: Rect): boolean {
  const angleDiff = Math.min(Math.abs(first.angle - second.angle), Math.PI - Math.abs(first.angle - second.angle));
  const offsetTolerance = Math.max(18, Math.min(bounds.width, bounds.height) * 0.028);
  return angleDiff <= degreesToRadians(3) && Math.abs(first.offset - second.offset) <= offsetTolerance;
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function normalizedLineAngle(direction: Point): number {
  const angle = Math.atan2(direction.y, direction.x);
  return angle < 0 ? angle + Math.PI : angle;
}

function normalizedLineOffset(point: Point, direction: Point): number {
  const normal = normalizeVector({ x: -direction.y, y: direction.x });
  let offset = normal.x * point.x + normal.y * point.y;
  if (offset < 0) {
    offset *= -1;
  }
  return offset;
}

async function createGridLines(bounds: Rect, settings: GenerationSettings): Promise<VectorNode[]> {
  const step = resolveGridStep(bounds, settings);
  const lines: VectorNode[] = [];

  for (let x = bounds.x; x <= bounds.x + bounds.width + 0.5; x += step) {
    lines.push(await createStyledLine("Vertical Gridline", x, bounds.y, x, bounds.y + bounds.height, settings, {
      opacity: settings.gridOpacity,
      weight: Math.max(0.4, settings.strokeWidth * 0.6),
    }));
  }

  for (let y = bounds.y; y <= bounds.y + bounds.height + 0.5; y += step) {
    lines.push(await createStyledLine("Horizontal Gridline", bounds.x, y, bounds.x + bounds.width, y, settings, {
      opacity: settings.gridOpacity,
      weight: Math.max(0.4, settings.strokeWidth * 0.6),
    }));
  }

  for (const line of lines) {
    line.strokes = [solidPaint(settings.gridColor, settings.gridOpacity)];
  }

  return lines;
}

function normalizedGridSizeToLegacyScale(value: number): number {
  const normalized = Math.max(0.1, Math.min(1, value));
  const legacyGridSize = 70 + ((normalized - 0.1) / 0.9) * 110;
  return legacyGridSize / 40;
}

function createGridDots(bounds: Rect, settings: GenerationSettings): SceneNode[] {
  const step = resolveGridStep(bounds, settings);
  const size = clamp(step * 0.12, 3, 8);
  const radius = size / 2;
  const circles: string[] = [];
  const fill = `#${normalizeHex(settings.gridColor)}`;
  const opacity = clampOpacity(settings.gridOpacity);

  for (let x = 0; x <= bounds.width + 0.5; x += step) {
    for (let y = 0; y <= bounds.height + 0.5; y += step) {
      circles.push(`<circle cx="${svgNumber(x)}" cy="${svgNumber(y)}" r="${svgNumber(radius)}" />`);
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(bounds.width)}" height="${svgNumber(bounds.height)}" viewBox="0 0 ${svgNumber(bounds.width)} ${svgNumber(bounds.height)}"><g fill="${fill}" fill-opacity="${svgNumber(opacity)}">${circles.join("")}</g></svg>`;
  const dotGrid = figma.createNodeFromSvg(svg);
  dotGrid.name = "Dot Grid Points";
  dotGrid.x = bounds.x;
  dotGrid.y = bounds.y;
  dotGrid.locked = settings.lockGuidelines;
  return [dotGrid];
}

function createConstructionCircles(circles: readonly CircleGuide[], settings: GenerationSettings): EllipseNode[] {
  return circles.map((circle, index) => {
    const ellipse = figma.createEllipse();
    const radiusX = circle.radiusX ?? circle.radius;
    const radiusY = circle.radiusY ?? circle.radius;
    ellipse.name = `Construction Circle ${index + 1}`;
    ellipse.x = circle.center.x - radiusX;
    ellipse.y = circle.center.y - radiusY;
    ellipse.resize(radiusX * 2, radiusY * 2);
    ellipse.fills = [];
    ellipse.strokes = [solidPaint(settings.guideColor, settings.guideOpacity)];
    ellipse.strokeWeight = settings.strokeWidth;
    ellipse.dashPattern = settings.lineStyle === "dashed" ? [8, 6] : [];
    ellipse.locked = settings.lockGuidelines;
    return ellipse;
  });
}

function collectCircularGuides(
  nodes: readonly SceneNode[],
  coordinateOrigin: Rect,
  canvasBounds: Rect,
  geometryTransform: GeometryTransform,
): CircleGuide[] {
  const circles: CircleGuide[] = [];

  for (const node of nodes) {
    if (node.type === "VECTOR") {
      circles.push(...vectorSegmentsToCircularGuides(node, coordinateOrigin, canvasBounds, geometryTransform));
      continue;
    }

    if ("children" in node) {
      circles.push(...collectCircularGuides([...node.children].filter(isSceneNode), coordinateOrigin, canvasBounds, geometryTransform));
    }
  }

  return dedupeCircularGuides(circles)
    .sort((a, b) => b.score - a.score)
    .slice(0, 18);
}

function vectorSegmentsToCircularGuides(
  node: VectorNode,
  coordinateOrigin: Rect,
  canvasBounds: Rect,
  geometryTransform: GeometryTransform,
): CircleGuide[] {
  const circles: CircleGuide[] = vectorRegionLoopsToCircularGuides(node, coordinateOrigin, geometryTransform);
  const vertices = node.vectorNetwork.vertices;

  for (const segment of node.vectorNetwork.segments) {
    const start = vertices[segment.start];
    const end = vertices[segment.end];
    if (!start || !end || !segment.tangentStart || !segment.tangentEnd || !hasTangent(segment.tangentStart) || !hasTangent(segment.tangentEnd)) {
      continue;
    }

    const sampled = sampleCubicBezierPoints(
      vectorLocalPointToOutputPoint(node, start.x, start.y, coordinateOrigin, geometryTransform),
      vectorLocalPointToOutputPoint(node, start.x + segment.tangentStart.x, start.y + segment.tangentStart.y, coordinateOrigin, geometryTransform),
      vectorLocalPointToOutputPoint(node, end.x + segment.tangentEnd.x, end.y + segment.tangentEnd.y, coordinateOrigin, geometryTransform),
      vectorLocalPointToOutputPoint(node, end.x, end.y, coordinateOrigin, geometryTransform),
      18,
    );
    const circle = fitCircleFromSampledArc(sampled, canvasBounds);

    if (circle) {
      circles.push(circle);
    }
  }

  return circles;
}

function vectorRegionLoopsToCircularGuides(node: VectorNode, coordinateOrigin: Rect, geometryTransform: GeometryTransform): CircleGuide[] {
  const regions = node.vectorNetwork.regions ?? [];
  const segments = node.vectorNetwork.segments;
  const vertices = node.vectorNetwork.vertices;
  const circles: CircleGuide[] = [];

  for (const region of regions) {
    for (const loop of region.loops) {
      const points: Point[] = [];

      for (const segmentIndex of loop) {
        const segment = segments[segmentIndex];
        if (!segment) {
          continue;
        }

        const start = vertices[segment.start];
        const end = vertices[segment.end];
        if (!start || !end) {
          continue;
        }

        if (segment.tangentStart && segment.tangentEnd && hasTangent(segment.tangentStart) && hasTangent(segment.tangentEnd)) {
          points.push(
            ...sampleCubicBezierPoints(
              vectorLocalPointToOutputPoint(node, start.x, start.y, coordinateOrigin, geometryTransform),
              vectorLocalPointToOutputPoint(node, start.x + segment.tangentStart.x, start.y + segment.tangentStart.y, coordinateOrigin, geometryTransform),
              vectorLocalPointToOutputPoint(node, end.x + segment.tangentEnd.x, end.y + segment.tangentEnd.y, coordinateOrigin, geometryTransform),
              vectorLocalPointToOutputPoint(node, end.x, end.y, coordinateOrigin, geometryTransform),
              8,
            ),
          );
          continue;
        }

        points.push(vectorLocalPointToOutputPoint(node, start.x, start.y, coordinateOrigin, geometryTransform));
        points.push(vectorLocalPointToOutputPoint(node, end.x, end.y, coordinateOrigin, geometryTransform));
      }

      const circle = circleFromClosedLoop(points);
      if (circle) {
        circles.push(circle);
      }
    }
  }

  return circles;
}

function circleFromClosedLoop(points: readonly Point[]): CircleGuide | null {
  if (points.length < 8) {
    return null;
  }

  const bounds = pointsToBounds(points);
  if (bounds.width < 8 || bounds.height < 8) {
    return null;
  }

  const aspectRatio = Math.max(bounds.width, bounds.height) / Math.min(bounds.width, bounds.height);
  if (aspectRatio > 1.08) {
    return null;
  }

  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const radiusX = bounds.width / 2;
  const radiusY = bounds.height / 2;
  const radius = (radiusX + radiusY) / 2;
  const radiusErrors = points.map((point) => Math.abs(distance(point, center) - radius));
  const meanError = radiusErrors.reduce((sum, value) => sum + value, 0) / radiusErrors.length;
  const relativeError = meanError / Math.max(1, radius);

  if (relativeError > 0.045) {
    return null;
  }

  return {
    center,
    radius,
    start: { x: center.x + radius, y: center.y },
    middle: { x: center.x, y: center.y + radius },
    end: { x: center.x - radius, y: center.y },
    arcAngle: 360,
    error: meanError,
    score: 8 - relativeError * 20 + radius * 0.01,
    source: "loop",
  };
}

function sampleCubicBezierPoints(p0: Point, p1: Point, p2: Point, p3: Point, count: number): Point[] {
  const points: Point[] = [];

  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    const mt = 1 - t;
    points.push({
      x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
      y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y,
    });
  }

  return points;
}

function fitCircleFromSampledArc(points: Point[], canvasBounds: Rect): CircleGuide | null {
  if (points.length < 7) {
    return null;
  }

  const first = points[0];
  const middle = points[Math.floor(points.length / 2)];
  const last = points[points.length - 1];
  const circle = circleFromThreePoints(first, middle, last);

  if (!circle) {
    return null;
  }

  const canvasMax = Math.max(canvasBounds.width, canvasBounds.height);
  const chord = distance(first, last);
  const arcAngle = arcAngleDegrees(first, middle, last, circle.center);
  const errors = points.map((point) => Math.abs(distance(point, circle.center) - circle.radius));
  const maxError = Math.max(...errors);
  const meanError = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const allowedError = Math.max(2.5, circle.radius * 0.06);

  if (circle.radius < 8 || circle.radius > canvasMax * 2.4 || chord < 10 || arcAngle < 8 || maxError > allowedError || meanError > allowedError * 0.8) {
    return null;
  }

  const errorScore = 1 / (1 + meanError);

  return {
    center: circle.center,
    radius: circle.radius,
    start: first,
    middle,
    end: last,
    arcAngle,
    error: meanError,
    score: arcAngle * 0.025 + errorScore,
    source: "arc",
  };
}

function circleFromThreePoints(a: Point, b: Point, c: Point): Pick<CircleGuide, "center" | "radius"> | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 0.01) {
    return null;
  }

  const aSq = a.x * a.x + a.y * a.y;
  const bSq = b.x * b.x + b.y * b.y;
  const cSq = c.x * c.x + c.y * c.y;
  const center = {
    x: (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d,
    y: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d,
  };

  return {
    center,
    radius: distance(center, a),
  };
}

function arcAngleDegrees(first: Point, middle: Point, last: Point, center: Point): number {
  const start = Math.atan2(first.y - center.y, first.x - center.x);
  const mid = Math.atan2(middle.y - center.y, middle.x - center.x);
  const end = Math.atan2(last.y - center.y, last.x - center.x);
  const clockwise = positiveAngleDifference(start, mid) + positiveAngleDifference(mid, end);
  const counterClockwise = positiveAngleDifference(end, mid) + positiveAngleDifference(mid, start);
  return (Math.min(clockwise, counterClockwise) * 180) / Math.PI;
}

function positiveAngleDifference(from: number, to: number): number {
  return ((to - from) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
}

function dedupeCircularGuides(circles: CircleGuide[]): CircleGuide[] {
  const result: CircleGuide[] = [];

  for (const circle of circles.sort((a, b) => b.score - a.score)) {
    const duplicate = result.some((existing) => areSimilarCircularGuides(existing, circle));
    if (!duplicate) {
      result.push(circle);
    }
  }

  return result;
}

function areSimilarCircularGuides(first: CircleGuide, second: CircleGuide): boolean {
  const radiusTolerance = Math.max(8, Math.min(first.radius, second.radius) * 0.06);
  const centerTolerance = Math.max(8, Math.min(first.radius, second.radius) * 0.08);
  return distance(first.center, second.center) <= centerTolerance && Math.abs(first.radius - second.radius) <= radiusTolerance;
}

function resolveGridStep(bounds: Rect, settings: GenerationSettings): number {
  return Math.max(8, Math.min(bounds.width, bounds.height) / Math.max(4, Math.round(8 * normalizedGridSizeToLegacyScale(settings.gridSize))));
}

function createAutoFrameBounds(_logoBounds: Rect): Rect {
  return {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  };
}

function resolveAutoFrameLogoTransform(logoBounds: Rect, canvasBounds: Rect): GeometryTransform {
  if (logoBounds.width <= 0 || logoBounds.height <= 0) {
    return IDENTITY_GEOMETRY_TRANSFORM;
  }

  const maxWidth = Math.max(1, canvasBounds.width - AUTO_FRAME_LOGO_HORIZONTAL_PADDING * 2);
  const scale = Math.min(AUTO_FRAME_LOGO_MAX_HEIGHT / logoBounds.height, maxWidth / logoBounds.width);
  const targetWidth = logoBounds.width * scale;
  const targetHeight = logoBounds.height * scale;

  return {
    scale,
    origin: {
      x: logoBounds.x,
      y: logoBounds.y,
    },
    targetOrigin: {
      x: canvasBounds.x + (canvasBounds.width - targetWidth) / 2,
      y: canvasBounds.y + (canvasBounds.height - targetHeight) / 2,
    },
  };
}

function resolveLogoGridFitTransform(logoBounds: Rect, canvasBounds: Rect, settings: GenerationSettings): GeometryTransform {
  if (settings.mode !== "construction" || !settings.gridEnabled || logoBounds.height <= 0) {
    return IDENTITY_GEOMETRY_TRANSFORM;
  }

  const step = resolveGridStep(canvasBounds, settings);
  const currentTop = logoBounds.y;
  const currentBottom = logoBounds.y + logoBounds.height;
  const targetTop = nearestGridLine(currentTop, canvasBounds.y, step);
  let targetBottom = nearestGridLine(currentBottom, canvasBounds.y, step);

  if (targetBottom <= targetTop) {
    targetBottom = targetTop + step;
  }

  const targetHeight = targetBottom - targetTop;
  const scale = targetHeight / logoBounds.height;

  if (Math.abs(scale - 1) < 0.001 && Math.abs(targetTop - currentTop) < 0.001) {
    return IDENTITY_GEOMETRY_TRANSFORM;
  }

  return {
    scale,
    origin: {
      x: logoBounds.x,
      y: logoBounds.y,
    },
    targetOrigin: {
      x: logoBounds.x,
      y: targetTop,
    },
  };
}

function nearestGridLine(value: number, gridOrigin: number, step: number): number {
  return gridOrigin + Math.round((value - gridOrigin) / step) * step;
}

function applyGeometryTransform(point: Point, transform: GeometryTransform): Point {
  if (transform.scale === 1 && transform.origin.x === transform.targetOrigin.x && transform.origin.y === transform.targetOrigin.y) {
    return point;
  }

  return {
    x: transform.targetOrigin.x + (point.x - transform.origin.x) * transform.scale,
    y: transform.targetOrigin.y + (point.y - transform.origin.y) * transform.scale,
  };
}

function createAnchorPoints(points: readonly Point[], bounds: Rect, settings: GenerationSettings): SceneNode[] {
  if (points.length === 0) {
    return [];
  }

  const size = pointControlSize(settings.anchorSize);
  const halfSize = size / 2;
  const fill = `#${normalizeHex(settings.anchorColor)}`;
  const fillOpacity = clampOpacity(settings.anchorOpacity);
  const strokeOpacity = Math.min(1, settings.anchorOpacity + 0.2);
  const strokeWeight = Math.max(0.2, settings.strokeWidth * 0.35);
  const elements = points.map((point) => {
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    if (settings.anchorShape === "circle") {
      return `<circle cx="${svgNumber(x)}" cy="${svgNumber(y)}" r="${svgNumber(halfSize)}" />`;
    }
    return `<rect x="${svgNumber(x - halfSize)}" y="${svgNumber(y - halfSize)}" width="${svgNumber(size)}" height="${svgNumber(size)}" />`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(bounds.width)}" height="${svgNumber(bounds.height)}" viewBox="0 0 ${svgNumber(bounds.width)} ${svgNumber(bounds.height)}" overflow="visible"><g fill="${fill}" fill-opacity="${svgNumber(fillOpacity)}" stroke="${fill}" stroke-opacity="${svgNumber(strokeOpacity)}" stroke-width="${svgNumber(strokeWeight)}">${elements.join("")}</g></svg>`;
  const anchorNode = figma.createNodeFromSvg(svg);
  anchorNode.name = "Anchor Points";
  anchorNode.x = bounds.x;
  anchorNode.y = bounds.y;
  anchorNode.locked = settings.lockGuidelines;
  return [anchorNode];
}

function collectVectorAnchorPoints(nodes: readonly SceneNode[], coordinateOrigin: Rect, geometryTransform: GeometryTransform = IDENTITY_GEOMETRY_TRANSFORM): Point[] {
  const points: Point[] = [];

  for (const node of nodes) {
    if (node.type === "VECTOR") {
      points.push(...vectorVerticesToLocalPoints(node, coordinateOrigin, geometryTransform));
      continue;
    }

    if ("children" in node) {
      points.push(...collectVectorAnchorPoints([...node.children].filter(isSceneNode), coordinateOrigin, geometryTransform));
    }
  }

  return dedupePoints(points);
}

function vectorVerticesToLocalPoints(node: VectorNode, coordinateOrigin: Rect, geometryTransform: GeometryTransform): Point[] {
  return node.vectorNetwork.vertices.map((vertex) => vectorLocalPointToOutputPoint(node, vertex.x, vertex.y, coordinateOrigin, geometryTransform));
}

function vectorLocalPointToOutputPoint(node: VectorNode, x: number, y: number, coordinateOrigin: Rect, geometryTransform: GeometryTransform = IDENTITY_GEOMETRY_TRANSFORM): Point {
  const absolutePoint = transformPoint(node.absoluteTransform, x, y);
  return applyGeometryTransform({
    x: absolutePoint.x - coordinateOrigin.x,
    y: absolutePoint.y - coordinateOrigin.y,
  }, geometryTransform);
}

function transformPoint(transform: Transform, x: number, y: number): Point {
  return {
    x: transform[0][0] * x + transform[0][1] * y + transform[0][2],
    y: transform[1][0] * x + transform[1][1] * y + transform[1][2],
  };
}

function transformToOutputSpace(transform: Transform, coordinateOrigin: Rect, geometryTransform: GeometryTransform): Transform {
  const translation = applyGeometryTransform({
    x: transform[0][2] - coordinateOrigin.x,
    y: transform[1][2] - coordinateOrigin.y,
  }, geometryTransform);

  return [
    [transform[0][0], transform[0][1], translation.x],
    [transform[1][0], transform[1][1], translation.y],
  ];
}

function dedupePoints(points: Point[]): Point[] {
  const seen = new Set<string>();
  const result: Point[] = [];

  for (const point of points) {
    const key = `${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(point);
    }
  }

  return result;
}

function selectKeyAnchorPoints(points: Point[], maxCount: number): Point[] {
  if (points.length <= maxCount) {
    return points;
  }

  const bounds = pointsToBounds(points);
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const diagonal = Math.max(1, Math.hypot(bounds.width, bounds.height));
  const minSpacing = Math.max(12, diagonal * 0.16);
  const scored = points
    .map((point) => ({
      point,
      score: distance(point, center) / diagonal + edgeAffinity(point, bounds) * 0.65 + pointIsolation(point, points) / diagonal,
    }))
    .sort((a, b) => b.score - a.score);
  const selected: Point[] = [];

  for (const candidate of scored) {
    if (selected.every((point) => distance(point, candidate.point) >= minSpacing)) {
      selected.push(candidate.point);
    }

    if (selected.length === maxCount) {
      return selected;
    }
  }

  for (const candidate of scored) {
    if (!selected.includes(candidate.point)) {
      selected.push(candidate.point);
    }

    if (selected.length === maxCount) {
      return selected;
    }
  }

  return selected;
}

function pointsToBounds(points: readonly Point[]): Rect {
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function edgeAffinity(point: Point, bounds: Rect): number {
  const xAffinity = Math.max(
    1 - Math.abs(point.x - bounds.x) / Math.max(1, bounds.width),
    1 - Math.abs(point.x - (bounds.x + bounds.width)) / Math.max(1, bounds.width),
  );
  const yAffinity = Math.max(
    1 - Math.abs(point.y - bounds.y) / Math.max(1, bounds.height),
    1 - Math.abs(point.y - (bounds.y + bounds.height)) / Math.max(1, bounds.height),
  );
  return Math.max(xAffinity, yAffinity);
}

function pointIsolation(point: Point, points: readonly Point[]): number {
  const distances = points
    .filter((candidate) => candidate !== point)
    .map((candidate) => distance(point, candidate))
    .sort((a, b) => a - b);
  return distances[0] ?? 0;
}

function isNearKeyAnchor(point: Point, keyAnchors: readonly Point[]): boolean {
  return keyAnchors.some((anchor) => distance(anchor, point) < 4);
}

function createHandleGuides(logoNodes: readonly SceneNode[], coordinateOrigin: Rect, bounds: Rect, geometryTransform: GeometryTransform, settings: GenerationSettings): SceneNode[] {
  const handles = collectVectorHandles(logoNodes, coordinateOrigin, geometryTransform);
  const lineElements: string[] = [];
  const pointElements: string[] = [];
  const pointRadius = pointControlSize(settings.handleSize) / 2;
  const stroke = `#${normalizeHex(settings.handleColor)}`;
  const lineOpacity = clampOpacity(settings.handleOpacity * 0.7);
  const pointOpacity = clampOpacity(settings.handleOpacity);
  const dash = settings.lineStyle === "dashed" ? ` stroke-dasharray="6 4"` : "";

  for (const handle of handles) {
    const length = distance(handle.anchor, handle.control);
    if (length < 3 || length > 180) {
      continue;
    }
    const displayControl = scalePointFromAnchor(handle.anchor, handle.control, settings.handleLength);
    lineElements.push(`<line x1="${svgNumber(handle.anchor.x - bounds.x)}" y1="${svgNumber(handle.anchor.y - bounds.y)}" x2="${svgNumber(displayControl.x - bounds.x)}" y2="${svgNumber(displayControl.y - bounds.y)}" />`);
    pointElements.push(`<circle cx="${svgNumber(displayControl.x - bounds.x)}" cy="${svgNumber(displayControl.y - bounds.y)}" r="${svgNumber(pointRadius)}" />`);
  }

  if (lineElements.length === 0) {
    return [];
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(bounds.width)}" height="${svgNumber(bounds.height)}" viewBox="0 0 ${svgNumber(bounds.width)} ${svgNumber(bounds.height)}" overflow="visible"><g stroke="${stroke}" stroke-opacity="${svgNumber(lineOpacity)}" stroke-width="${svgNumber(settings.handleLineWeight)}" stroke-linecap="round" fill="none"${dash}>${lineElements.join("")}</g><g fill="${stroke}" fill-opacity="${svgNumber(pointOpacity)}">${pointElements.join("")}</g></svg>`;
  const handleNode = figma.createNodeFromSvg(svg);
  handleNode.name = "Handle Guides";
  handleNode.x = bounds.x;
  handleNode.y = bounds.y;
  handleNode.locked = settings.lockGuidelines;
  return [handleNode];
}

async function createAngleGuides(
  logoNodes: readonly SceneNode[],
  coordinateOrigin: Rect,
  geometryTransform: GeometryTransform,
  keyAnchors: readonly Point[],
  logoBounds: Rect,
  settings: GenerationSettings,
): Promise<SceneNode[]> {
  const scale = resolveAngleGuideScale(logoBounds);
  const guides = selectAngleGuides(collectAnchorAngleGuides(logoNodes, coordinateOrigin, geometryTransform, scale), keyAnchors);
  const nodes: SceneNode[] = [];

  if (guides.length === 0) {
    return nodes;
  }

  for (const guide of guides) {
    const startRay = await createStyledLine("Angle Ray", guide.anchor.x, guide.anchor.y, guide.startRay.x, guide.startRay.y, settings, {
      opacity: settings.guideOpacity,
      weight: settings.strokeWidth,
    });
    const endRay = await createStyledLine("Angle Ray", guide.anchor.x, guide.anchor.y, guide.endRay.x, guide.endRay.y, settings, {
      opacity: settings.guideOpacity,
      weight: settings.strokeWidth,
    });
    const arc = await createPolyline("Angle Arc", guide.arcPoints, settings, {
      opacity: settings.guideOpacity,
      weight: settings.strokeWidth,
    });
    const point = createAnglePoint(guide.anchor, settings, scale);
    startRay.strokes = [solidPaint(settings.guideColor, settings.guideOpacity)];
    endRay.strokes = [solidPaint(settings.guideColor, settings.guideOpacity)];
    arc.strokes = [solidPaint(settings.guideColor, settings.guideOpacity)];
    nodes.push(startRay, endRay, arc, point);
  }

  try {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  } catch {
    return nodes;
  }

  for (const guide of guides) {
    const text = figma.createText();
    text.name = `Angle Label ${guide.angle}deg`;
    text.fontName = { family: "Inter", style: "Regular" };
    text.fontSize = clamp(5 * scale, 5, 14);
    text.characters = `${guide.angle}\u00B0`;
    text.fills = [solidPaint(settings.guideColor, Math.min(1, settings.guideOpacity + 0.15))];
    text.x = guide.labelPosition.x - text.width / 2;
    text.y = guide.labelPosition.y - text.height / 2;
    text.locked = settings.lockGuidelines;
    nodes.push(text);
  }

  return nodes;
}

function selectAngleGuides(guides: readonly AnchorAngleGuide[], keyAnchors: readonly Point[]): AnchorAngleGuide[] {
  const preferredGuides = guides.filter((guide) => isNearKeyAnchor(guide.anchor, keyAnchors)).slice(0, 3);
  if (preferredGuides.length > 0) {
    return preferredGuides;
  }

  return guides.slice(0, 1);
}

async function createPolyline(
  name: string,
  points: readonly Point[],
  settings: GenerationSettings,
  style: { opacity: number; weight: number },
): Promise<VectorNode> {
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const line = figma.createVector();
  line.name = name;
  line.x = minX;
  line.y = minY;
  await line.setVectorNetworkAsync({
    vertices: points.map((point) => ({ x: point.x - minX, y: point.y - minY })),
    segments: points.slice(1).map((_, index) => ({ start: index, end: index + 1 })),
    regions: [],
  });
  line.fills = [];
  line.strokes = [solidPaint(settings.guideColor, style.opacity)];
  line.strokeWeight = style.weight;
  line.locked = settings.lockGuidelines;
  return line;
}

function createAnglePoint(point: Point, settings: GenerationSettings, scale = 1): EllipseNode {
  const marker = figma.createEllipse();
  marker.name = "Angle Anchor Point";
  const size = Math.max(1.2, settings.strokeWidth * 1.8 * scale);
  marker.x = point.x - size / 2;
  marker.y = point.y - size / 2;
  marker.resize(size, size);
  marker.fills = [solidPaint(settings.guideColor, Math.min(1, settings.guideOpacity + 0.1))];
  marker.strokes = [];
  marker.locked = settings.lockGuidelines;
  return marker;
}

function collectAnchorAngleGuides(nodes: readonly SceneNode[], coordinateOrigin: Rect, geometryTransform: GeometryTransform = IDENTITY_GEOMETRY_TRANSFORM, scale = 1): AnchorAngleGuide[] {
  const guides: AnchorAngleGuide[] = [];

  for (const node of nodes) {
    if (node.type === "VECTOR") {
      guides.push(...vectorSegmentsToAnchorAngleGuides(node, coordinateOrigin, geometryTransform, scale));
      continue;
    }

    if ("children" in node) {
      guides.push(...collectAnchorAngleGuides([...node.children].filter(isSceneNode), coordinateOrigin, geometryTransform, scale));
    }
  }

  return dedupeAnchorAngleGuides(guides.sort((a, b) => b.weight - a.weight)).slice(0, 18);
}

function vectorSegmentsToAnchorAngleGuides(node: VectorNode, coordinateOrigin: Rect, geometryTransform: GeometryTransform, scale = 1): AnchorAngleGuide[] {
  const directionsByVertex = new Map<number, Point[]>();
  const vertices = node.vectorNetwork.vertices;

  for (const segment of node.vectorNetwork.segments) {
    const start = vertices[segment.start];
    const end = vertices[segment.end];
    if (!start || !end) {
      continue;
    }

    const startPoint = vectorLocalPointToOutputPoint(node, start.x, start.y, coordinateOrigin, geometryTransform);
    const endPoint = vectorLocalPointToOutputPoint(node, end.x, end.y, coordinateOrigin, geometryTransform);
    const segmentLength = distance(startPoint, endPoint);
    const hasCurvedHandle = Boolean((segment.tangentStart && hasTangent(segment.tangentStart)) || (segment.tangentEnd && hasTangent(segment.tangentEnd)));
    const curvedPoints = sampleCurvedSegmentPoints(node, segment, coordinateOrigin, geometryTransform);

    if (segmentLength < 12 || (hasCurvedHandle && (!curvedPoints || !isNearlyStraightSegment(curvedPoints)))) {
      continue;
    }

    addAnchorDirection(directionsByVertex, segment.start, endPoint.x - startPoint.x, endPoint.y - startPoint.y);
    addAnchorDirection(directionsByVertex, segment.end, startPoint.x - endPoint.x, startPoint.y - endPoint.y);
  }

  const guides: AnchorAngleGuide[] = [];

  for (const [vertexIndex, directions] of directionsByVertex) {
    const vertex = vertices[vertexIndex];
    if (!vertex || directions.length < 2) {
      continue;
    }

    const anchor = vectorLocalPointToOutputPoint(node, vertex.x, vertex.y, coordinateOrigin, geometryTransform);
    const guide = directionsToAnchorAngleGuide(anchor, directions, scale);
    if (guide) {
      guides.push(guide);
    }
  }

  return guides;
}

function addAnchorDirection(directionsByVertex: Map<number, Point[]>, vertexIndex: number, x: number, y: number) {
  const length = Math.hypot(x, y);
  if (length < 3) {
    return;
  }

  const directions = directionsByVertex.get(vertexIndex) ?? [];
  directions.push({ x, y });
  directionsByVertex.set(vertexIndex, directions);
}

function directionsToAnchorAngleGuide(anchor: Point, directions: readonly Point[], scale = 1): AnchorAngleGuide | null {
  const pair = strongestAnglePair(directions);
  if (!pair) {
    return null;
  }

  const [first, second] = pair;
  const firstUnit = normalizeVector(first);
  const secondUnit = normalizeVector(second);
  const angle = smallerAngleDegrees(firstUnit, secondUnit);
  if (angle < 18 || angle > 162) {
    return null;
  }

  const rayLength = clamp(Math.min(vectorLength(first), vectorLength(second)) * 0.55, 18 * scale, 42 * scale);
  const arcRadius = clamp(rayLength * 0.42, 8 * scale, 18 * scale);
  const arc = minorArcPoints(anchor, firstUnit, secondUnit, arcRadius, 12);
  const bisector = normalizeVector({
    x: firstUnit.x + secondUnit.x,
    y: firstUnit.y + secondUnit.y,
  });

  return {
    angle: Math.round(angle),
    anchor,
    startRay: {
      x: anchor.x + firstUnit.x * rayLength,
      y: anchor.y + firstUnit.y * rayLength,
    },
    endRay: {
      x: anchor.x + secondUnit.x * rayLength,
      y: anchor.y + secondUnit.y * rayLength,
    },
    arcPoints: arc,
    labelPosition: {
      x: anchor.x + bisector.x * (arcRadius + 8 * scale),
      y: anchor.y + bisector.y * (arcRadius + 8 * scale),
    },
    weight: angle + rayLength * 0.2,
  };
}

function resolveAngleGuideScale(bounds: Rect): number {
  const diagonal = Math.hypot(bounds.width, bounds.height);
  return clamp(diagonal / 260, 1, 3);
}

function strongestAnglePair(directions: readonly Point[]): [Point, Point] | null {
  let best: { pair: [Point, Point]; score: number } | null = null;

  for (let firstIndex = 0; firstIndex < directions.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < directions.length; secondIndex += 1) {
      const first = directions[firstIndex];
      const second = directions[secondIndex];
      const angle = smallerAngleDegrees(first, second);
      const score = angle + Math.min(vectorLength(first), vectorLength(second)) * 0.08;
      if (angle >= 18 && angle <= 162 && (!best || score > best.score)) {
        best = { pair: [first, second], score };
      }
    }
  }

  return best?.pair ?? null;
}

function minorArcPoints(anchor: Point, first: Point, second: Point, radius: number, steps: number): Point[] {
  const firstAngle = Math.atan2(first.y, first.x);
  const secondAngle = Math.atan2(second.y, second.x);
  let delta = positiveAngleDifference(firstAngle, secondAngle);
  let start = firstAngle;

  if (delta > Math.PI) {
    delta = Math.PI * 2 - delta;
    start = secondAngle;
  }

  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = start + delta * (index / steps);
    return {
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
    };
  });
}

function smallerAngleDegrees(first: Point, second: Point): number {
  const firstAngle = Math.atan2(first.y, first.x);
  const secondAngle = Math.atan2(second.y, second.x);
  const delta = positiveAngleDifference(firstAngle, secondAngle);
  return (Math.min(delta, Math.PI * 2 - delta) * 180) / Math.PI;
}

function normalizeVector(vector: Point): Point {
  const length = Math.max(0.0001, vectorLength(vector));
  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function vectorLength(vector: Point): number {
  return Math.hypot(vector.x, vector.y);
}

function dedupeAnchorAngleGuides(guides: AnchorAngleGuide[]): AnchorAngleGuide[] {
  const result: AnchorAngleGuide[] = [];

  for (const guide of guides) {
    const tooClose = result.some((existing) => distance(existing.anchor, guide.anchor) < 12);
    if (!tooClose) {
      result.push(guide);
    }
  }

  return result;
}

function collectVectorHandles(nodes: readonly SceneNode[], coordinateOrigin: Rect, geometryTransform: GeometryTransform = IDENTITY_GEOMETRY_TRANSFORM): HandlePoint[] {
  const handles: HandlePoint[] = [];

  for (const node of nodes) {
    if (node.type === "VECTOR") {
      handles.push(...vectorSegmentsToHandles(node, coordinateOrigin, geometryTransform));
      continue;
    }

    if ("children" in node) {
      handles.push(...collectVectorHandles([...node.children].filter(isSceneNode), coordinateOrigin, geometryTransform));
    }
  }

  return handles;
}

function vectorSegmentsToHandles(node: VectorNode, coordinateOrigin: Rect, geometryTransform: GeometryTransform): HandlePoint[] {
  const handles: HandlePoint[] = [];
  const vertices = node.vectorNetwork.vertices;

  for (const segment of node.vectorNetwork.segments) {
    const start = vertices[segment.start];
    const end = vertices[segment.end];

    if (start && segment.tangentStart && hasTangent(segment.tangentStart)) {
      const anchor = vectorLocalPointToOutputPoint(node, start.x, start.y, coordinateOrigin, geometryTransform);
      const control = vectorLocalPointToOutputPoint(node, start.x + segment.tangentStart.x, start.y + segment.tangentStart.y, coordinateOrigin, geometryTransform);
      handles.push({ anchor, control });
    }

    if (end && segment.tangentEnd && hasTangent(segment.tangentEnd)) {
      const anchor = vectorLocalPointToOutputPoint(node, end.x, end.y, coordinateOrigin, geometryTransform);
      const control = vectorLocalPointToOutputPoint(node, end.x + segment.tangentEnd.x, end.y + segment.tangentEnd.y, coordinateOrigin, geometryTransform);
      handles.push({ anchor, control });
    }
  }

  return dedupeHandles(handles);
}

function hasTangent(tangent: Vector): boolean {
  return Math.abs(tangent.x) > 0.01 || Math.abs(tangent.y) > 0.01;
}

function scalePointFromAnchor(anchor: Point, point: Point, scale: number): Point {
  return {
    x: anchor.x + (point.x - anchor.x) * scale,
    y: anchor.y + (point.y - anchor.y) * scale,
  };
}

async function createHandleLine(anchor: Point, control: Point, settings: GenerationSettings): Promise<VectorNode> {
  const line = await createStyledLine("Handle Line", anchor.x, anchor.y, control.x, control.y, settings, {
    opacity: settings.handleOpacity * 0.7,
    weight: settings.handleLineWeight,
  });
  line.strokes = [solidPaint(settings.handleColor, settings.handleOpacity * 0.7)];
  return line;
}

function createHandlePoint(point: Point, settings: GenerationSettings): EllipseNode {
  const diamond = figma.createEllipse();
  diamond.name = "Handle Point";
  const size = pointControlSize(settings.handleSize);
  diamond.x = point.x - size / 2;
  diamond.y = point.y - size / 2;
  diamond.resize(size, size);
  diamond.fills = [solidPaint(settings.handleColor, settings.handleOpacity)];
  diamond.strokes = [];
  diamond.locked = settings.lockGuidelines;
  return diamond;
}

function pointControlSize(value: number): number {
  return clampFinite(value, 0.1, 5, 1) * 4;
}

function dedupeHandles(handles: HandlePoint[]): HandlePoint[] {
  const seen = new Set<string>();
  const result: HandlePoint[] = [];

  for (const handle of handles) {
    const key = `${roundPoint(handle.anchor)}>${roundPoint(handle.control)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(handle);
    }
  }

  return result;
}

function roundPoint(point: Point): string {
  return `${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10}`;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function createPotentialErrors(bounds: Rect, settings: GenerationSettings): Promise<VectorNode[]> {
  return [
    await createErrorLine("Alignment Warnings", bounds.x, bounds.y - 12, bounds.x + bounds.width, bounds.y - 12, settings),
  ];
}

async function createErrorLine(name: string, x1: number, y1: number, x2: number, y2: number, settings: GenerationSettings): Promise<VectorNode> {
  const line = await createLine(name, x1, y1, x2, y2, settings);
  line.strokes = [solidPaint("#DC2626", 0.6)];
  return line;
}

async function removePreviousGeneratedGroups(options: { exceptId?: string; restoreSources?: boolean } = {}) {
  const restoreSources = options.restoreSources ?? true;
  const removableParents: ChildrenMixin[] = [figma.currentPage];
  const container = lastContainerNodeId ? await figma.getNodeByIdAsync(lastContainerNodeId) : null;

  if (isContainerNode(container)) {
    removableParents.push(container);
  }

  for (const parent of removableParents) {
    for (const child of [...parent.children]) {
      if ("getPluginData" in child && child.getPluginData("pluginGenerated") === "true") {
        if (child.id === options.exceptId) {
          continue;
        }

        if (restoreSources) {
          await restoreSourceNodesVisibilityFromGroup(child);
        }
        child.remove();
      }
    }
  }
}

function placeGeneratedGroup(group: SceneNode, context: GenerationContext) {
  const container = context.container;

  if (!container) {
    placeGroupBeforeFirstLogo(group, context.logoNodes);
    return;
  }

  const logoChildIndexes = context.logoNodes
    .map((node) => topLevelChildIndex(container, node))
    .filter((index): index is number => typeof index === "number");
  const insertIndex = logoChildIndexes.length > 0 ? Math.min(...logoChildIndexes) : container.children.length;
  container.insertChild(insertIndex, group);
}

function placeGroupBeforeFirstLogo(group: SceneNode, logoNodes: readonly SceneNode[]) {
  const firstLogo = logoNodes[0];
  const parent = firstLogo?.parent;
  if (!parent || !("children" in parent) || !("insertChild" in parent)) {
    return;
  }

  const index = [...parent.children].findIndex((child) => child.id === firstLogo.id);
  if (index >= 0) {
    parent.insertChild(index, group);
  }
}

function topLevelChildIndex(container: ContainerNode, node: SceneNode): number | null {
  let current: BaseNode | null = node;

  while (current?.parent && current.parent.id !== container.id) {
    current = current.parent;
  }

  if (!current || current.parent?.id !== container.id) {
    return null;
  }

  return [...container.children].findIndex((child) => child.id === current?.id);
}

function resolveClearspace(bounds: Rect, settings: GenerationSettings): number {
  if (settings.clearspaceUnit === "logomark") {
    return Math.max(8, Math.min(bounds.width, bounds.height) * (settings.clearspaceValue / 100));
  }

  if (settings.clearspaceUnit === "centimeters") {
    return settings.clearspaceValue * 37.795;
  }

  if (settings.clearspaceUnit === "inches") {
    return settings.clearspaceValue * 96;
  }

  return settings.clearspaceValue;
}

function getSelectionBounds(nodes: readonly SceneNode[]): Rect {
  const visibleNodes = nodes.filter((node) => "absoluteBoundingBox" in node && node.absoluteBoundingBox);
  if (visibleNodes.length === 0) {
    throw new Error("Selected nodes do not have visible bounds.");
  }

  const boxes = visibleNodes.map((node) => node.absoluteBoundingBox as Rect);
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function toLocalRect(rect: Rect, origin: Rect): Rect {
  return {
    x: rect.x - origin.x,
    y: rect.y - origin.y,
    width: rect.width,
    height: rect.height,
  };
}

function solidPaint(hex: string, opacity: number): SolidPaint {
  const normalized = normalizeHex(hex);
  const value = Number.parseInt(normalized, 16);
  return {
    type: "SOLID",
    color: {
      r: ((value >> 16) & 255) / 255,
      g: ((value >> 8) & 255) / 255,
      b: (value & 255) / 255,
    },
    opacity: clampOpacity(opacity),
  };
}

function relativeLuminance(color: RgbColor): number {
  const channels = [color.r, color.g, color.b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function rgbToHsl(color: RgbColor): HslColor {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;

  if (max === r) {
    hue = (g - b) / delta + (g < b ? 6 : 0);
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }

  return { h: hue * 60, s: saturation, l: lightness };
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = clamp(saturation, 0, 1);
  const l = clamp(lightness, 0, 1);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - chroma / 2;
  const normalizedHue = ((hue % 360) + 360) % 360;
  let r = 0;
  let g = 0;
  let b = 0;

  if (normalizedHue < 60) {
    r = chroma;
    g = x;
  } else if (normalizedHue < 120) {
    r = x;
    g = chroma;
  } else if (normalizedHue < 180) {
    g = chroma;
    b = x;
  } else if (normalizedHue < 240) {
    g = x;
    b = chroma;
  } else if (normalizedHue < 300) {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function clampOpacity(value: number): number {
  return clampFinite(value, 0, 1, 1);
}

function normalizeUiHex(hex: string): string {
  return `#${normalizeHex(String(hex))}`;
}

function svgNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function normalizeHex(hex: string): string {
  const cleaned = hex.replace("#", "").trim();
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return cleaned;
  }
  return "2383E2";
}

function postToUi(message: PluginToUiMessage) {
  figma.ui.postMessage(message);
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface HslColor {
  h: number;
  s: number;
  l: number;
}

type AutoPalette = Pick<
  GenerationSettings,
  "backgroundColor" | "backgroundOpacity" | "gridColor" | "logoFillColor" | "logoOutlineColor" | "guideColor" | "anchorColor" | "handleColor"
>;

type AutoPalettes = Record<GenerationSettings["canvasPreset"], AutoPalette>;

interface Point {
  x: number;
  y: number;
}

const IDENTITY_GEOMETRY_TRANSFORM: GeometryTransform = {
  scale: 1,
  origin: { x: 0, y: 0 },
  targetOrigin: { x: 0, y: 0 },
};

interface GeometryTransform {
  scale: number;
  origin: Point;
  targetOrigin: Point;
}

interface HandlePoint {
  anchor: Point;
  control: Point;
}

interface LineGuide {
  start: Point;
  end: Point;
  angle: number;
  offset: number;
  score: number;
}

interface AnchorAngleGuide {
  angle: number;
  anchor: Point;
  startRay: Point;
  endRay: Point;
  arcPoints: Point[];
  labelPosition: Point;
  weight: number;
}

interface CircleGuide {
  center: Point;
  radius: number;
  radiusX?: number;
  radiusY?: number;
  start: Point;
  middle: Point;
  end: Point;
  arcAngle: number;
  error: number;
  score: number;
  source?: "arc" | "loop";
}

type ContainerNode = SceneNode & ChildrenMixin;

interface GenerationContext {
  container: ContainerNode | null;
  logoNodes: SceneNode[];
  autoPalettes?: AutoPalettes | null;
}

interface LogoAnalysisContext {
  nodes: SceneNode[];
  cleanup: () => void;
}

interface GenerationResult {
  group: SceneNode;
  settings: GenerationSettings;
}

interface FigmaPaymentsApi {
  status: {
    type: "UNPAID" | "PAID" | "NOT_SUPPORTED";
  };
  initiateCheckoutAsync(options?: { interstitial?: "PAID_FEATURE" | "TRIAL_ENDED" | "SKIP" }): Promise<void>;
  getPluginPaymentTokenAsync?(): Promise<string>;
}
