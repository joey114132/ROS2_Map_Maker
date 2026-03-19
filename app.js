/**
 * ROS 2 Map Maker - Core Logic
 */

const canvas = document.getElementById('map-canvas');
const ctx = canvas.getContext('2d');
const coordsDisplay = document.getElementById('coords-display');
const wallCountDisplay = document.getElementById('wall-count');
const resInput = document.getElementById('resolution');
const gridInput = document.getElementById('grid-size');
const snapToggle = document.getElementById('snap-toggle');

// State
let width, height;
let scale = 50; // pixels per meter
let offsetX = 0;
let offsetY = 0;
let walls = [];
let currentTool = 'wall';
let isDrawing = false;
let isPanning = false;
let startPoint = null;
let currentPoint = null;
let lastMouseX = 0;
let lastMouseY = 0;
let isShiftPressed = false;
let alignToggle = document.getElementById('align-toggle');
let objects = []; // boxes, cylinders
let selectedWallIndex = -1;
let selectedObjectIndex = -1;
let selectedHandle = null; // 'p1', 'p2', 'nw', 'ne', 'sw', 'se', 'center'
let dragStartTime = 0;
let alignmentLines = { x: null, y: null };
let lastDrawnPixel = null;

let history = [];
let historyIndex = -1;

function saveState() {
    history = history.slice(0, historyIndex + 1);
    history.push({
        walls: JSON.parse(JSON.stringify(walls)),
        objects: JSON.parse(JSON.stringify(objects))
    });
    historyIndex++;
}

function undo() {
    if (historyIndex > 0) {
        historyIndex--;
        restoreState(history[historyIndex]);
    }
}

function redo() {
    if (historyIndex < history.length - 1) {
        historyIndex++;
        restoreState(history[historyIndex]);
    }
}

function restoreState(state) {
    walls = JSON.parse(JSON.stringify(state.walls));
    objects = JSON.parse(JSON.stringify(state.objects));
    selectedWallIndex = -1;
    selectedObjectIndex = -1;
    selectedHandle = null;
    updateStats();
    render();
}

// Initialize
function init() {
    window.addEventListener('resize', resize);
    resize();
    
    // Tools
    document.getElementById('tool-wall').addEventListener('click', () => setTool('wall'));
    document.getElementById('tool-box').addEventListener('click', () => setTool('box'));
    document.getElementById('tool-cylinder').addEventListener('click', () => setTool('cylinder'));
    document.getElementById('tool-pen').addEventListener('click', () => setTool('pen'));
    document.getElementById('tool-select').addEventListener('click', () => setTool('select'));
    document.getElementById('tool-erase').addEventListener('click', () => setTool('erase'));
    if (document.getElementById('undo-btn')) document.getElementById('undo-btn').addEventListener('click', undo);
    if (document.getElementById('redo-btn')) document.getElementById('redo-btn').addEventListener('click', redo);
    
    // Canvas events
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel);
    
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Shift') isShiftPressed = true;
        
        if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
            if (e.shiftKey) redo();
            else undo();
            return;
        }
        if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
            redo();
            return;
        }

        if (e.key === 'w' || e.key === 'W') setTool('wall');
        if (e.key === 'b' || e.key === 'B') setTool('box');
        if (e.key === 'c' || e.key === 'C') setTool('cylinder');
        if (e.key === 'p' || e.key === 'P') setTool('pen');
        if (e.key === 's' || e.key === 'S') setTool('select');
        if (e.key === 'e' || e.key === 'E') setTool('erase');
        if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    });

    window.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') isShiftPressed = false;
    });

    if (document.getElementById('import-pgm')) {
        document.getElementById('import-pgm').addEventListener('change', handleImportPGM);
    }

    saveState(); // Save initial blank state
    render();
}

function resize() {
    width = canvas.parentElement.clientWidth;
    height = canvas.parentElement.clientHeight;
    canvas.width = width;
    canvas.height = height;
    
    // Center origin if first time
    if (offsetX === 0 && offsetY === 0) {
        offsetX = width / 2;
        offsetY = height / 2;
    }
    render();
}

function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.toolbar button').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tool-${tool}`).classList.add('active');
}

// Coordinate transformations
function screenToWorld(x, y) {
    return {
        x: (x - offsetX) / scale,
        y: -(y - offsetY) / scale // ROS is Y-up
    };
}

function worldToScreen(x, y) {
    return {
        x: x * scale + offsetX,
        y: -y * scale + offsetY
    };
}

function snap(val, step) {
    if (!snapToggle.checked) return val;
    return Math.round(val / step) * step;
}

function snapToCell(val, res) {
    return Math.floor(val / res) * res + res / 2;
}

// Interaction
function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    lastMouseX = mouseX;
    lastMouseY = mouseY;

    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        isPanning = true;
        canvas.style.cursor = 'grabbing';
        return;
    }

    const world = screenToWorld(mouseX, mouseY);
    const grid = parseFloat(gridInput.value);
    const snapped = getSnappedPoint(world, grid);

    if (currentTool === 'pen' && e.altKey) {
        const res = parseFloat(resInput.value);
        for (let i = objects.length - 1; i >= 0; i--) {
            const o = objects[i];
            if (o.type === 'pixel' && world.x >= o.x - res/2 && world.x <= o.x + res/2 && world.y >= o.y - res/2 && world.y <= o.y + res/2) {
                const colorInput = document.getElementById('pen-color');
                if (colorInput) colorInput.value = o.color || '#ffffff';
                return;
            }
        }
        return; // Clicked blank space with Alt
    }

    if (currentTool === 'wall' || currentTool === 'box' || currentTool === 'cylinder' || currentTool === 'erase' || currentTool === 'pen') {
        isDrawing = true;
        startPoint = (currentTool === 'erase') ? world : snapped;
        currentPoint = startPoint;
        if (currentTool === 'pen') {
            const color = document.getElementById('pen-color') ? document.getElementById('pen-color').value : '#ffffff';
            objects.push({ type: 'pixel', x: snapped.x, y: snapped.y, color: color });
            lastDrawnPixel = { x: snapped.x, y: snapped.y };
            updateStats();
        }
    } else if (currentTool === 'select') {
        const hitRadius = 0.25; 
        
        // Handle hit detection for selected item first
        if (selectedWallIndex !== -1) {
            const w = walls[selectedWallIndex];
            if (dist(world, w.p1) < 0.2) { selectedHandle = 'p1'; return; }
            if (dist(world, w.p2) < 0.2) { selectedHandle = 'p2'; return; }
            if (distToSegment(world, w.p1, w.p2) < 0.1) { selectedHandle = 'move'; return; }
        }
        if (selectedObjectIndex !== -1) {
            const o = objects[selectedObjectIndex];
            if (o.type === 'box') {
                const hw = o.w/2; const hh = o.h/2;
                if (dist(world, {x: o.x-hw, y: o.y+hh}) < 0.2) { selectedHandle = 'nw'; return; }
                if (dist(world, {x: o.x+hw, y: o.y+hh}) < 0.2) { selectedHandle = 'ne'; return; }
                if (dist(world, {x: o.x-hw, y: o.y-hh}) < 0.2) { selectedHandle = 'sw'; return; }
                if (dist(world, {x: o.x+hw, y: o.y-hh}) < 0.2) { selectedHandle = 'se'; return; }
                if (world.x >= o.x-hw && world.x <= o.x+hw && world.y >= o.y-hh && world.y <= o.y+hh) { selectedHandle = 'move'; return; }
            } else if (o.type === 'cylinder') {
                if (Math.abs(dist(world, o) - o.r) < 0.1) { selectedHandle = 'resize'; return; }
                if (dist(world, o) < o.r) { selectedHandle = 'move'; return; }
            } else if (o.type === 'pixel') {
                const res = parseFloat(resInput.value);
                if (world.x >= o.x - res/2 && world.x <= o.x + res/2 && 
                    world.y >= o.y - res/2 && world.y <= o.y + res/2) { selectedHandle = 'move'; return; }
            }
        }

        // Normal hit detection
        let hitW = -1;
        let hitO = -1;
        
        walls.forEach((w, i) => {
            if (distToSegment(world, w.p1, w.p2) < hitRadius) hitW = i;
        });

        objects.forEach((o, i) => {
            if (o.type === 'box') {
                if (world.x >= o.x - o.w/2 && world.x <= o.x + o.w/2 && 
                    world.y >= o.y - o.h/2 && world.y <= o.y + o.h/2) hitO = i;
            } else if (o.type === 'cylinder') {
                if (dist(world, o) < o.r) hitO = i;
            } else if (o.type === 'pixel') {
                const res = parseFloat(resInput.value);
                if (world.x >= o.x - res/2 && world.x <= o.x + res/2 && 
                    world.y >= o.y - res/2 && world.y <= o.y + res/2) hitO = i;
            }
        });
        
        selectedWallIndex = hitW;
        selectedObjectIndex = hitO;
        if (hitW !== -1 || hitO !== -1) selectedHandle = 'move';
    }
    render();
}

function getSnappedPoint(p, grid) {
    if (currentTool === 'pen') {
        const res = parseFloat(resInput.value);
        return { x: snapToCell(p.x, res), y: snapToCell(p.y, res) };
    }
    
    let pt = { x: snap(p.x, grid), y: snap(p.y, grid) };
    alignmentLines = { x: null, y: null };
    
    if (alignToggle.checked) {
        const threshold = 0.15; // 15cm alignment snap
        const allPoints = [];
        walls.forEach(w => { allPoints.push(w.p1, w.p2); });
        objects.forEach(o => { allPoints.push({x: o.x, y: o.y}); });

        for (let other of allPoints) {
            if (Math.abs(p.x - other.x) < threshold) {
                pt.x = other.x;
                alignmentLines.x = other.x;
            }
            if (Math.abs(p.y - other.y) < threshold) {
                pt.y = other.y;
                alignmentLines.y = other.y;
            }
        }
    }
    return pt;
}

function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const world = screenToWorld(mouseX, mouseY);
    coordsDisplay.textContent = `${world.x.toFixed(2)}m, ${world.y.toFixed(2)}m`;

    if (isPanning) {
        offsetX += mouseX - lastMouseX;
        offsetY += mouseY - lastMouseY;
        lastMouseX = mouseX;
        lastMouseY = mouseY;
    } else if (isDrawing) {
        const grid = parseFloat(gridInput.value);
        let target = getSnappedPoint(world, grid);

        if (isShiftPressed && currentTool === 'wall') {
            const dx = Math.abs(target.x - startPoint.x);
            const dy = Math.abs(target.y - startPoint.y);
            if (dx > dy) target.y = startPoint.y;
            else target.x = startPoint.x;
        }
        currentPoint = currentTool === 'erase' ? world : target;

        if (currentTool === 'pen') {
            const snappedX = target.x;
            const snappedY = target.y;
            if (!lastDrawnPixel || lastDrawnPixel.x !== snappedX || lastDrawnPixel.y !== snappedY) {
                // Also check if a pixel already exists at this location to avoid stacking
                const exists = objects.some(o => o.type === 'pixel' && o.x === snappedX && o.y === snappedY);
                if (!exists) {
                    const color = document.getElementById('pen-color') ? document.getElementById('pen-color').value : '#ffffff';
                    objects.push({ type: 'pixel', x: snappedX, y: snappedY, color: color });
                    lastDrawnPixel = { x: snappedX, y: snappedY };
                }
            }
        }
    } else if (currentTool === 'select' && selectedHandle) {
        const grid = parseFloat(gridInput.value);
        const snapped = getSnappedPoint(world, grid);
        
        if (selectedWallIndex !== -1) {
            const w = walls[selectedWallIndex];
            if (selectedHandle === 'p1') w.p1 = snapped;
            if (selectedHandle === 'p2') w.p2 = snapped;
            if (selectedHandle === 'move') {
                const dx = snapped.x - world.x; // Simplified move
                const dy = snapped.y - world.y;
                // Complex move logic omitted for brevity, let's just update p1/p2 offset
                const moveX = world.x - lastWorldX;
                const moveY = world.y - lastWorldY;
                w.p1.x += moveX; w.p1.y += moveY;
                w.p2.x += moveX; w.p2.y += moveY;
            }
        } else if (selectedObjectIndex !== -1) {
            const o = objects[selectedObjectIndex];
            if (selectedHandle === 'move') {
                o.x += world.x - lastWorldX;
                o.y += world.y - lastWorldY;
            } else if (o.type === 'box') {
                if (selectedHandle === 'nw') { o.w += (o.x - snapped.x)*2; o.h += (snapped.y - o.y)*2; o.x = (o.x + snapped.x)/2; o.y = (o.y + snapped.y)/2; }
                // Simplified resize for now: just follow the snapped point
                if (selectedHandle === 'se') { 
                    const nw = { x: o.x - o.w/2, y: o.y + o.h/2 };
                    o.w = Math.abs(snapped.x - nw.x);
                    o.h = Math.abs(snapped.y - nw.y);
                    o.x = (nw.x + snapped.x) / 2;
                    o.y = (nw.y + snapped.y) / 2;
                }
            } else if (o.type === 'cylinder' && selectedHandle === 'resize') {
                o.r = dist(o, world);
            }
        }
    }
    
    lastWorldX = world.x;
    lastWorldY = world.y;
    render();
}

let lastWorldX = 0, lastWorldY = 0;

function onMouseUp() {
    isPanning = false;
    let hadHandle = selectedHandle !== null;
    selectedHandle = null;
    canvas.style.cursor = 'crosshair';
    
    let changed = false;

    if (isDrawing) {
        if (currentTool === 'pen') {
            changed = true; // since pixels are dropped eagerly
        } else if (currentTool === 'erase') {
            const minX = Math.min(startPoint.x, currentPoint.x);
            const maxX = Math.max(startPoint.x, currentPoint.x);
            const minY = Math.min(startPoint.y, currentPoint.y);
            const maxY = Math.max(startPoint.y, currentPoint.y);
            
            if (dist(startPoint, currentPoint) < 0.01) {
                // Point erase
                const hitRadius = 0.25; 
                let hitW = -1; let hitO = -1;
                const res = parseFloat(resInput.value);
                walls.forEach((w, i) => { if (distToSegment(startPoint, w.p1, w.p2) < hitRadius) hitW = i; });
                objects.forEach((o, i) => {
                    if (o.type === 'box') {
                        if (startPoint.x >= o.x - o.w/2 && startPoint.x <= o.x + o.w/2 && startPoint.y >= o.y - o.h/2 && startPoint.y <= o.y + o.h/2) hitO = i;
                    } else if (o.type === 'cylinder') {
                        if (dist(startPoint, o) < o.r) hitO = i;
                    } else if (o.type === 'pixel') {
                        if (startPoint.x >= o.x - res/2 && startPoint.x <= o.x + res/2 && startPoint.y >= o.y - res/2 && startPoint.y <= o.y + res/2) hitO = i;
                    }
                });
                if (hitW !== -1) { walls.splice(hitW, 1); changed = true; }
                else if (hitO !== -1) { objects.splice(hitO, 1); changed = true; }
            } else {
                // Area erase
                const origW = walls.length; const origO = objects.length;
                walls = walls.filter(w => {
                    const cx = (w.p1.x + w.p2.x)/2; const cy = (w.p1.y + w.p2.y)/2;
                    return cx < minX || cx > maxX || cy < minY || cy > maxY;
                });
                objects = objects.filter(o => o.x < minX || o.x > maxX || o.y < minY || o.y > maxY);
                if (walls.length < origW || objects.length < origO) changed = true;
            }
            if (changed) updateStats();
        } else if (dist(startPoint, currentPoint) > 0.01) {
            if (currentTool === 'wall') {
                walls.push({ p1: startPoint, p2: currentPoint });
            } else if (currentTool === 'box') {
                const w = Math.abs(currentPoint.x - startPoint.x);
                const h = Math.abs(currentPoint.y - startPoint.y);
                const cx = (startPoint.x + currentPoint.x) / 2;
                const cy = (startPoint.y + currentPoint.y) / 2;
                objects.push({ type: 'box', x: cx, y: cy, w: w, h: h });
            } else if (currentTool === 'cylinder') {
                const r = dist(startPoint, currentPoint);
                objects.push({ type: 'cylinder', x: startPoint.x, y: startPoint.y, r: r });
            }
            updateStats();
            changed = true;
        }
        isDrawing = false;
        startPoint = null;
        currentPoint = null;
    } else if (currentTool === 'select' && hadHandle) {
        changed = true;
    }
    
    if (changed) saveState();
    render();
}

function onWheel(e) {
    e.preventDefault();
    const zoomSpeed = 1.1;
    const delta = e.deltaY > 0 ? 1/zoomSpeed : zoomSpeed;
    
    // Zoom around mouse
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    const worldBefore = screenToWorld(mx, my);
    scale *= delta;
    
    // Readjust offset to keep mouse over same world point
    const screenAfter = worldToScreen(worldBefore.x, worldBefore.y);
    offsetX += mx - screenAfter.x;
    offsetY += my - screenAfter.y;
    
    render();
}

function deleteSelected() {
    if (selectedWallIndex !== -1) {
        walls.splice(selectedWallIndex, 1);
        selectedWallIndex = -1;
        updateStats();
        saveState();
        render();
    } else if (selectedObjectIndex !== -1) {
        objects.splice(selectedObjectIndex, 1);
        selectedObjectIndex = -1;
        updateStats();
        saveState();
        render();
    }
}

function updateStats() {
    wallCountDisplay.textContent = walls.length;
}

// Drawing logic
function render() {
    ctx.clearRect(0, 0, width, height);
    
    drawGrid();
    drawAxes();
    drawAlignmentGuides();

    // Draw existing walls
    walls.forEach((w, i) => {
        const s1 = worldToScreen(w.p1.x, w.p1.y);
        const s2 = worldToScreen(w.p2.x, w.p2.y);
        
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        
        if (i === selectedWallIndex) {
            ctx.strokeStyle = '#58a6ff';
            ctx.lineWidth = 4;
            ctx.setLineDash([5, 5]);
        } else {
            ctx.strokeStyle = '#f0f6fc';
            ctx.lineWidth = 3;
            ctx.setLineDash([]);
        }
        ctx.stroke();
    });

    // Draw objects
    objects.forEach((o, i) => {
        const s = worldToScreen(o.x, o.y);
        ctx.beginPath();
        if (o.type === 'box') {
            const sw = o.w * scale;
            const sh = o.h * scale;
            ctx.rect(s.x - sw/2, s.y - sh/2, sw, sh);
        } else if (o.type === 'cylinder') {
            ctx.arc(s.x, s.y, o.r * scale, 0, Math.PI * 2);
        } else if (o.type === 'pixel') {
            const res = parseFloat(resInput.value) * scale;
            // Only draw if within reasonable bounds (avoid artifacts if scale is extreme)
            if (res > 0.1) {
                ctx.rect(s.x - res/2, s.y - res/2, res, res);
            }
        }
        
        if (i === selectedObjectIndex) {
            ctx.strokeStyle = '#58a6ff';
            ctx.fillStyle = 'rgba(88, 166, 255, 0.4)';
            ctx.setLineDash([5, 5]);
        } else {
            ctx.strokeStyle = '#f0f6fc';
            ctx.fillStyle = 'rgba(240, 246, 252, 0.2)';
            ctx.setLineDash([]);
        }
        
        if (o.type === 'pixel' && i !== selectedObjectIndex) {
             ctx.fillStyle = o.color || '#a3b1c6';
             ctx.strokeStyle = 'rgba(0,0,0,0.1)';
        }
        
        ctx.fill();
        ctx.stroke();
    });

    // Draw selection handles
    if (currentTool === 'select') {
        if (selectedWallIndex !== -1) {
            const w = walls[selectedWallIndex];
            drawHandle(w.p1);
            drawHandle(w.p2);
        }
        if (selectedObjectIndex !== -1) {
            const o = objects[selectedObjectIndex];
            const s = worldToScreen(o.x, o.y);
            if (o.type === 'box') {
                const sw = o.w * scale; const sh = o.h * scale;
                drawHandle({x: o.x - o.w/2, y: o.y + o.h/2}); // nw
                drawHandle({x: o.x + o.w/2, y: o.y + o.h/2}); // ne
                drawHandle({x: o.x - o.w/2, y: o.y - o.h/2}); // sw
                drawHandle({x: o.x + o.w/2, y: o.y - o.h/2}); // se
            } else if (o.type === 'cylinder') {
                drawHandle({x: o.x + o.r, y: o.y});
            } else if (o.type === 'pixel') {
                drawHandle({x: o.x, y: o.y});
            }
        }
    }
    
    // Draw preview
    if (isDrawing) {
        const s1 = worldToScreen(startPoint.x, startPoint.y);
        const s2 = worldToScreen(currentPoint.x, currentPoint.y);
        ctx.beginPath();
        if (currentTool === 'wall') {
            ctx.moveTo(s1.x, s1.y);
            ctx.lineTo(s2.x, s2.y);
        } else if (currentTool === 'box') {
            ctx.rect(Math.min(s1.x, s2.x), Math.min(s1.y, s2.y), Math.abs(s2.x-s1.x), Math.abs(s2.y-s1.y));
        } else if (currentTool === 'cylinder') {
            ctx.arc(s1.x, s1.y, dist(startPoint, currentPoint) * scale, 0, Math.PI * 2);
        } else if (currentTool === 'erase') {
            ctx.fillStyle = 'rgba(255, 100, 100, 0.2)';
            ctx.strokeStyle = '#ff6464';
            ctx.fillRect(Math.min(s1.x, s2.x), Math.min(s1.y, s2.y), Math.abs(s2.x-s1.x), Math.abs(s2.y-s1.y));
            ctx.strokeRect(Math.min(s1.x, s2.x), Math.min(s1.y, s2.y), Math.abs(s2.x-s1.x), Math.abs(s2.y-s1.y));
            return; // specific drawing logic finishes here for erase
        }
        ctx.strokeStyle = 'rgba(88, 166, 255, 0.6)';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

function drawGrid() {
    const grid = parseFloat(gridInput.value);
    const step = grid * scale;
    
    ctx.beginPath();
    ctx.strokeStyle = '#1d2127';
    ctx.lineWidth = 1;
    
    const startX = offsetX % step;
    for (let x = startX; x < width; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
    }
    
    const startY = offsetY % step;
    for (let y = startY; y < height; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
    }
    ctx.stroke();
}

function drawAxes() {
    ctx.beginPath();
    ctx.lineWidth = 2;
    
    // X axis (Red in ROS)
    ctx.strokeStyle = 'rgba(255, 100, 100, 0.5)';
    ctx.moveTo(0, offsetY);
    ctx.lineTo(width, offsetY);
    ctx.stroke();
    
    // Y axis (Green in ROS)
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(100, 255, 100, 0.5)';
    ctx.moveTo(offsetX, 0);
    ctx.lineTo(offsetX, height);
    ctx.stroke();
}

function drawAlignmentGuides() {
    if (!alignmentLines.x && !alignmentLines.y) return;
    
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ff7b72'; // Reddish guide color
    
    if (alignmentLines.x !== null) {
        const s = worldToScreen(alignmentLines.x, 0);
        ctx.beginPath();
        ctx.moveTo(s.x, 0);
        ctx.lineTo(s.x, height);
        ctx.stroke();
    }
    
    if (alignmentLines.y !== null) {
        const s = worldToScreen(0, alignmentLines.y);
        ctx.beginPath();
        ctx.moveTo(0, s.y);
        ctx.lineTo(width, s.y);
        ctx.stroke();
    }
    ctx.setLineDash([]);
}

function drawHandle(point) {
    const s = worldToScreen(point.x, point.y);
    ctx.fillStyle = '#58a6ff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
}

// Math helpers
function dist(p1, p2) {
    return Math.sqrt((p1.x-p2.x)**2 + (p1.y-p2.y)**2);
}

function distToSegment(p, v, w) {
  const l2 = dist(v, w)**2;
  if (l2 == 0) return dist(p, v);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
}

function handleImportPGM(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(event) {
        const arrayBuffer = event.target.result;
        const view = new Uint8Array(arrayBuffer);
        let offset = 0;

        function nextToken() {
            while (offset < view.length && isSpace(view[offset])) offset++;
            if (offset >= view.length) return null;
            if (view[offset] === 35) { // # comment
                while (offset < view.length && view[offset] !== 10) offset++;
                return nextToken();
            }
            let start = offset;
            while (offset < view.length && !isSpace(view[offset])) offset++;
            return String.fromCharCode.apply(null, view.subarray(start, offset));
        }

        function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13; }

        const magic = nextToken();
        if (magic !== 'P5' && magic !== 'P2') {
            alert('Unsupported format: ' + magic);
            return;
        }

        const width = parseInt(nextToken(), 10);
        const height = parseInt(nextToken(), 10);
        const maxVal = parseInt(nextToken(), 10);
        
        offset++;

        const resolution = parseFloat(resInput.value);
        // Anchor origin to grid intersection (multiple of resolution)
        const originX = Math.round(-(width * resolution) / 2 / resolution) * resolution;
        const originY = Math.round(-(height * resolution) / 2 / resolution) * resolution;

        let addedCount = 0;

        if (magic === 'P5') {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const val = view[offset + y * width + x];
                    if (val < 100) {
                        const worldX = originX + (x + 0.5) * resolution;
                        const worldY = originY + (height - y - 0.5) * resolution;
                        
                        const sx = snapToCell(worldX, resolution);
                        const sy = snapToCell(worldY, resolution);
                        
                        // Check for duplicates
                        if (!objects.some(o => o.type === 'pixel' && Math.abs(o.x - sx) < 0.001 && Math.abs(o.y - sy) < 0.001)) {
                            objects.push({ type: 'pixel', x: sx, y: sy, color: '#a3b1c6' });
                            addedCount++;
                        }
                    }
                }
            }
        } else if (magic === 'P2') {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const val = parseInt(nextToken(), 10);
                    if (val < 100) {
                        const worldX = originX + (x + 0.5) * resolution;
                        const worldY = originY + (height - y - 0.5) * resolution;
                        
                        const sx = snapToCell(worldX, resolution);
                        const sy = snapToCell(worldY, resolution);

                        if (!objects.some(o => o.type === 'pixel' && Math.abs(o.x - sx) < 0.001 && Math.abs(o.y - sy) < 0.001)) {
                            objects.push({ type: 'pixel', x: sx, y: sy, color: '#a3b1c6' });
                            addedCount++;
                        }
                    }
                }
            }
        }
        
        console.log(`Vectorized ${addedCount} pixels from PGM!`);
        updateStats();
        saveState();
        render();
        e.target.value = '';
    };
    reader.readAsArrayBuffer(file);
}

init();
