import { Universe } from "wasm-water-simulation";
import { __wbindgen_memory } from "../pkg/wasm_water_simulation_bg";

const CELL_SIZE = 15; // px
const GRID_COLOR = "#CCCCCC";
const WATER_COLOR = "#0339fc";

// Construct the universe, and get its width and height.
Universe.new().then(async (universe) => {
    // // Initialize the map
    // const map = L.map('map').setView([51.505, -0.09], 13);

    // // Add OpenStreetMap tile layer
    // L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    //     attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    //     maxZoom: 19,
    // }).addTo(map);
    const memory = await __wbindgen_memory();
    const width = universe.width();
    const height = universe.height();
    // Give the canvas room for all of our cells and a 1px border
    // around each of them.
    const canvas = document.getElementById("wasm-water-simulation");
    canvas.height = (CELL_SIZE + 1) * height + 1;
    canvas.width = (CELL_SIZE + 1) * width + 1;
    const ctx = canvas.getContext('2d');
    let animationId = null;
    let msWaitTicks = 900;
    let count = 0;
    const playPauseButton = document.getElementById("play-pause");
    const stepButton = document.getElementById("step");
    const speedDisplay = document.getElementById('speed-display');
    const tickRange = document.getElementById('tick-range');
    tickRange.addEventListener('input', () => {
        msWaitTicks = (100 - tickRange.value) * 10;
        speedDisplay.textContent = `Render Speed: ${1000 / msWaitTicks} FPS`;
    });
    tickRange.value = 666; // Default value
    tickRange.setAttribute('data-value', tickRange.value);
    tickRange.addEventListener('input', () => {
        tickRange.setAttribute('data-value', tickRange.value);
        msWaitTicks = (100 - tickRange.value) * 10;
        console.log(`Adjusted msWaitTicks to: ${msWaitTicks}`);
    });

    const iterationCount = document.getElementById("iteration");
    const heightInfo = document.getElementById('height');
    const locationInfo = document.getElementById('row-col');

    let lastRenderTime = 0;
    const renderLoop = (timestamp) => {
        if (!lastRenderTime || timestamp - lastRenderTime >= msWaitTicks) {
            lastRenderTime = timestamp;
            universe.tick();
            drawCells();
            iterationCount.textContent = `Current iteration: ${animationId}`;
        }
        animationId = requestAnimationFrame(renderLoop);
    };

    const isPaused = () => {
        return animationId === null;
    };
    const play = () => {
        playPauseButton.textContent = "⏸";
        lastRenderTime = 0; // Reset to avoid unnecessary delay
        animationId = requestAnimationFrame(renderLoop);
    };

    const pause = () => {
        playPauseButton.textContent = "▶";
        cancelAnimationFrame(animationId);
        animationId = null;
    };

    playPauseButton.addEventListener("click", () => {
        if (isPaused()) {
            play();
        } else {
            pause();
        }
    });

    stepButton.addEventListener("click", () => {
        universe.tick();
        drawCells();
        animationId = requestAnimationFrame(renderLoop);
        iterationCount.textContent = `Current iteration: ${animationId}`;
        count = 0;
    });


    const drawGrid = () => {
        ctx.beginPath();
        ctx.strokeStyle = GRID_COLOR;

        // Vertical lines.
        for (let i = 0; i <= width; i++) {
            ctx.moveTo(i * (CELL_SIZE + 1) + 1, 0);
            ctx.lineTo(i * (CELL_SIZE + 1) + 1, (CELL_SIZE + 1) * height + 1);
        }

        // Horizontal lines.
        for (let j = 0; j <= height; j++) {
            ctx.moveTo(0, j * (CELL_SIZE + 1) + 1);
            ctx.lineTo((CELL_SIZE + 1) * width + 1, j * (CELL_SIZE + 1) + 1);
        }

        ctx.stroke();
    };

    const getIndex = (row, column) => {
        return row * width + column;
    };

    const drawCells = () => {
        const maxHeight = universe.max_height();
        const minHeight = universe.min_height();
        const cellsPtr = universe.cells();
        const waterCellsPtr = universe.water_cell_locations();
        const waterCellsCount = universe.water_cells_count();
        const cells = new Uint32Array(memory.buffer, cellsPtr, width * height);
        const originalArray = new Uint32Array(memory.buffer, waterCellsPtr, waterCellsCount * 2);
        const waterCells = Array.from(originalArray);
        const waterCellsMap = {};
        if (cellsPtr + width * height * Uint32Array.BYTES_PER_ELEMENT > memory.buffer.byteLength) {
            console.error("Cells pointer exceeds memory buffer bounds!");
        }
        while (waterCells.length) {
            const splicedArray = waterCells.splice(0, 2);
            waterCellsMap[splicedArray.join("")] = splicedArray;
        }
        ctx.beginPath();
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const idx = getIndex(row, col);
                let key = [row, col].join("");
                if (waterCellsMap[key]) {
                    ctx.fillStyle = WATER_COLOR;
                } else {
                    const normalized = (cells[idx] - minHeight) * (255) / (maxHeight - minHeight)
                    ctx.fillStyle = `rgb(
                    ${normalized},
                    ${normalized},
                    ${normalized})`
                }
                ctx.fillRect(
                    col * (CELL_SIZE + 1) + 1,
                    row * (CELL_SIZE + 1) + 1,
                    CELL_SIZE,
                    CELL_SIZE
                );
            }
        }

        ctx.stroke();
    };

    canvas.addEventListener("mousemove", event => {
        const boundingRect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / boundingRect.width;
        const scaleY = canvas.height / boundingRect.height;
        const canvasLeft = (event.clientX - boundingRect.left) * scaleX;
        const canvasTop = (event.clientY - boundingRect.top) * scaleY;
        const row = Math.min(Math.floor(canvasTop / (CELL_SIZE + 1)), height - 1);
        const col = Math.min(Math.floor(canvasLeft / (CELL_SIZE + 1)), width - 1);
        heightInfo.textContent = `Height value: ${universe.get_cell_value(row, col)}`;
        locationInfo.textContent = `Row-Col: ${row}-${col}`;
        universe.handle_user_input(row, col);
    })

    drawGrid();
    drawCells();
    requestAnimationFrame(renderLoop);
}).catch((err) => {
    console.log(err)
});




