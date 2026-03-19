/**
 * ROS 2 Map Maker - Exporter Logic
 * Generates PGM/YAML for Nav2 and SDF for Gazebo
 */

document.getElementById('export-nav2').addEventListener('click', exportNav2);
document.getElementById('export-gazebo').addEventListener('click', exportGazebo);

function exportNav2() {
    if (walls.length === 0 && objects.length === 0) {
        alert("Draw some walls or objects first!");
        return;
    }

    const scaleStr = prompt("Enter Export Scale Factor (e.g., 1.0 = 100%, 10.0 = 1000% larger map):", "1.0");
    const exportScale = Math.min(10, Math.max(0.1, parseFloat(scaleStr) || 1.0));

    const resolution = parseFloat(resInput.value);
    
    // 1. Calculate bounds (applied to scaled world coords)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    walls.forEach(w => {
        minX = Math.min(minX, w.p1.x * exportScale, w.p2.x * exportScale);
        minY = Math.min(minY, w.p1.y * exportScale, w.p2.y * exportScale);
        maxX = Math.max(maxX, w.p1.x * exportScale, w.p2.x * exportScale);
        maxY = Math.max(maxY, w.p1.y * exportScale, w.p2.y * exportScale);
    });
    
    objects.forEach(o => {
        const ox = o.x * exportScale;
        const oy = o.y * exportScale;
        if (o.type === 'box') {
            const ow = o.w * exportScale;
            const oh = o.h * exportScale;
            minX = Math.min(minX, ox - ow/2);
            minY = Math.min(minY, oy - oh/2);
            maxX = Math.max(maxX, ox + ow/2);
            maxY = Math.max(maxY, oy + oh/2);
        } else if (o.type === 'cylinder') {
            const or = o.r * exportScale;
            minX = Math.min(minX, ox - or);
            minY = Math.min(minY, oy - or);
            maxX = Math.max(maxX, ox + or);
            maxY = Math.max(maxY, oy + or);
        } else if (o.type === 'pixel') {
            const res = parseFloat(resInput.value) * exportScale;
            minX = Math.min(minX, ox - res/2);
            minY = Math.min(minY, oy - res/2);
            maxX = Math.max(maxX, ox + res/2);
            maxY = Math.max(maxY, oy + res/2);
        }
    });

    // Replace calculations to use scaled coords
    const getScaledX = (origX) => (origX * exportScale - minX) / resolution;
    const getScaledY = (origY) => pxHeight - (origY * exportScale - minY) / resolution;

    // Add padding (0.5m)
    const padding = 0.5;
    minX -= padding; minY -= padding; maxX += padding; maxY += padding;
    
    const widthMeters = maxX - minX;
    const heightMeters = maxY - minY;
    const pxWidth = Math.ceil(widthMeters / resolution);
    const pxHeight = Math.ceil(heightMeters / resolution);

    // 2. Create offscreen canvas for PGM generation
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = pxWidth;
    exportCanvas.height = pxHeight;
    const ectx = exportCanvas.getContext('2d');

    // Fill with unknown (205 is typical for grey) or free (254)
    // For Map Server: 0 is occupied, 255 is free, 205 is unknown
    // Actually, PGM is usually 0 (black, occupied) and 255 (white, free)
    ectx.fillStyle = 'white';
    ectx.fillRect(0, 0, pxWidth, pxHeight);

    ectx.strokeStyle = 'black';
    ectx.lineWidth = Math.max(1, 0.1 / resolution); // 10cm wall thickness approx

    walls.forEach(w => {
        // Map world to pixel (careful with Y direction)
        const x1 = (w.p1.x * exportScale - minX) / resolution;
        const y1 = pxHeight - (w.p1.y * exportScale - minY) / resolution;
        const x2 = (w.p2.x * exportScale - minX) / resolution;
        const y2 = pxHeight - (w.p2.y * exportScale - minY) / resolution;

        ectx.beginPath();
        ectx.moveTo(x1, y1);
        ectx.lineTo(x2, y2);
        ectx.stroke();
    });

    objects.forEach(o => {
        const x = (o.x * exportScale - minX) / resolution;
        const y = pxHeight - (o.y * exportScale - minY) / resolution;
        if (o.type === 'box') {
            const w = (o.w * exportScale) / resolution;
            const h = (o.h * exportScale) / resolution;
            ectx.fillStyle = 'black';
            ectx.fillRect(x - w/2, y - h/2, w, h);
        } else if (o.type === 'cylinder') {
            const r = (o.r * exportScale) / resolution;
            ectx.beginPath();
            ectx.arc(x, y, r, 0, Math.PI * 2);
            ectx.fillStyle = 'black';
            ectx.fill();
        } else if (o.type === 'pixel') {
            const w = (parseFloat(resInput.value) * exportScale) / resolution;
            ectx.fillStyle = 'black';
            ectx.fillRect(x - w/2, y - w/2, w, w);
        }
    });

    // 3. Export YAML
    const yaml = `image: map.pgm
resolution: ${resolution}
origin: [${minX.toFixed(3)}, ${minY.toFixed(3)}, 0.0]
negate: 0
occupied_thresh: 0.65
free_thresh: 0.196`;

    downloadFile('map.yaml', yaml);
    
    // 4. Export PGM (P5 Binary)
    const imgData = ectx.getImageData(0, 0, pxWidth, pxHeight).data;
    const header = `P5\n${pxWidth} ${pxHeight}\n255\n`;
    const headerUint8 = new TextEncoder().encode(header);
    const pgmData = new Uint8Array(headerUint8.length + pxWidth * pxHeight);
    pgmData.set(headerUint8);
    
    for (let i = 0; i < pxWidth * pxHeight; i++) {
        // Just take the red channel (it's grayscale anyway)
        pgmData[headerUint8.length + i] = imgData[i * 4];
    }
    
    const blob = new Blob([pgmData], { type: 'image/x-portable-graymap' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = 'map.pgm';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

function exportGazebo() {
    if (walls.length === 0 && objects.length === 0) {
        alert("Draw some walls or objects first!");
        return;
    }

    const scaleStr = prompt("Enter Export Scale Factor (e.g., 1.0 = 100%, 10.0 = 1000% larger world):", "1.0");
    const exportScale = Math.min(10, Math.max(0.1, parseFloat(scaleStr) || 1.0));

    let sdf = `<?xml version='1.0'?>
<sdf version='1.6'>
  <world name='default'>
    <include>
      <uri>model://ground_plane</uri>
    </include>
    <include>
      <uri>model://sun</uri>
    </include>
`;

    walls.forEach((w, i) => {
        const dx = (w.p2.x - w.p1.x) * exportScale;
        const dy = (w.p2.y - w.p1.y) * exportScale;
        const length = Math.sqrt(dx*dx + dy*dy);
        const angle = Math.atan2(dy, dx);
        const cx = ((w.p1.x + w.p2.x) / 2) * exportScale;
        const cy = ((w.p1.y + w.p2.y) / 2) * exportScale;

        sdf += `
    <model name='wall_${i}'>
      <static>1</static>
      <link name='link'>
        <pose>${cx} ${cy} 1.25 0 0 ${angle}</pose>
        <collision name='collision'>
          <geometry>
            <box>
              <size>${length} 0.15 2.5</size>
            </box>
          </geometry>
        </collision>
        <visual name='visual'>
          <geometry>
            <box>
              <size>${length} 0.15 2.5</size>
            </box>
          </geometry>
          <material>
            <script>
              <uri>file://media/materials/scripts/gazebo.material</uri>
              <name>Gazebo/Grey</name>
            </script>
          </material>
        </visual>
      </link>
    </model>`;
    });

    objects.forEach((o, i) => {
        let geometry = '';
        let z = 0.5;
        const ox = o.x * exportScale;
        const oy = o.y * exportScale;

        if (o.type === 'box') {
            const ow = o.w * exportScale;
            const oh = o.h * exportScale;
            geometry = `<box><size>${ow} ${oh} 1.0</size></box>`;
        } else if (o.type === 'cylinder') {
            const or = o.r * exportScale;
            geometry = `<cylinder><radius>${or}</radius><length>1.0</length></cylinder>`;
        } else if (o.type === 'pixel') {
            const res = parseFloat(resInput.value) * exportScale;
            geometry = `<box><size>${res} ${res} 0.5</size></box>`;
            z = 0.25;
        }

        sdf += `
    <model name='obj_${i}'>
      <static>1</static>
      <link name='link'>
        <pose>${ox} ${oy} ${z} 0 0 0</pose>
        <collision name='collision'>
          <geometry>
            ${geometry}
          </geometry>
        </collision>
        <visual name='visual'>
          <geometry>
            ${geometry}
          </geometry>
          <material>
            <script>
              <uri>file://media/materials/scripts/gazebo.material</uri>
              <name>Gazebo/Blue</name>
            </script>
          </material>
        </visual>
      </link>
    </model>`;
    });

    sdf += `
  </world>
</sdf>`;

    downloadFile('map.world', sdf);
}

function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}
