// ═══════════════════════════════════════════════════════
// Main — Pod Transit Digital Twin
// App initialization, Leaflet map, UI binding
// ═══════════════════════════════════════════════════════

import { SimulationEngine, POD_STATES } from './simulation.js';
import { NETWORKS } from './routes-data.js';

// ── Globals ──
let map, sim;
let routeLayers = [];
let stationMarkers = [];
let podMarkers = {};
let obstacleMarkers = {};
let activeTab = 'simulation';

// ── Initialize ──
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initSimulation();
  initUI();
});

// ── Map ──
function initMap() {
  map = L.map('map', {
    center: [19.1, 72.88],
    zoom: 12,
    zoomControl: true,
    attributionControl: false,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
  }).addTo(map);

  // Custom CSS override for dark tiles
  document.querySelector('.leaflet-tile-pane').style.filter = 'none';
}

function renderNetwork(networkId) {
  // Clear previous
  routeLayers.forEach(l => map.removeLayer(l));
  stationMarkers.forEach(m => map.removeLayer(m));
  Object.values(podMarkers).forEach(m => map.removeLayer(m));
  Object.values(obstacleMarkers).forEach(m => map.removeLayer(m));
  routeLayers = [];
  stationMarkers = [];
  podMarkers = {};
  obstacleMarkers = {};

  const network = NETWORKS[networkId];
  if (!network) return;

  const bounds = L.latLngBounds();

  // Draw routes
  for (const route of network.routes) {
    const latlngs = route.coords.map(c => [c[0], c[1]]);
    const line = L.polyline(latlngs, {
      color: network.color,
      weight: 3,
      opacity: 0.7,
      smoothFactor: 1.5,
      className: 'route-line',
    }).addTo(map);
    
    line.bindTooltip(route.name, {
      sticky: true,
      className: 'route-tooltip',
      direction: 'top',
    });
    
    routeLayers.push(line);
    latlngs.forEach(ll => bounds.extend(ll));
  }

  // Draw stations
  const stations = sim.graph.nodes;
  for (const station of stations) {
    const className = station.isDepot ? 'depot-marker' : 'station-marker';
    const icon = L.divIcon({
      className: className,
      iconSize: station.isDepot ? [16, 16] : [12, 12],
      iconAnchor: station.isDepot ? [8, 8] : [6, 6],
    });

    const marker = L.marker([station.lat, station.lng], { icon })
      .addTo(map)
      .bindTooltip(station.name, { direction: 'top', offset: [0, -8] });
    
    marker.on('click', () => showStationPopup(station));
    stationMarkers.push(marker);
    bounds.extend([station.lat, station.lng]);
  }

  // Fit map
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [60, 420, 60, 60], maxZoom: 15 });
  }

  // Add legend
  addLegend(network);
}

function addLegend(network) {
  document.querySelectorAll('.route-legend').forEach(el => el.remove());
  
  const legend = document.createElement('div');
  legend.className = 'route-legend';
  legend.innerHTML = `
    <div class="legend-item">
      <span class="legend-line" style="background:${network.color}"></span>
      <span>${network.label}</span>
    </div>
    <div class="legend-item">
      <span class="station-marker" style="width:10px;height:10px;display:inline-block"></span>
      <span>Station (${sim.graph.nodes.filter(n=>!n.isDepot).length})</span>
    </div>
    <div class="legend-item">
      <span class="depot-marker" style="width:10px;height:10px;display:inline-block;border-radius:3px"></span>
      <span>Depot</span>
    </div>
    <div class="legend-item">
      <span style="width:10px;height:10px;border-radius:50%;background:var(--pod-active);display:inline-block;box-shadow:0 0 6px var(--pod-active)"></span>
      <span>Pod (${sim.pods.length})</span>
    </div>
  `;
  document.getElementById('app').appendChild(legend);
}

function showStationPopup(station) {
  const popup = document.getElementById('station-popup');
  popup.style.display = 'block';
  document.getElementById('popup-station-name').textContent = station.name;
  document.getElementById('popup-waiting').textContent = station.waiting;
  document.getElementById('popup-demand').textContent = station.demand > 0.5 ? 'High' : station.demand > 0.25 ? 'Medium' : 'Low';
  
  const incoming = sim.pods.filter(p => p.targetNodeId === station.id).length;
  document.getElementById('popup-incoming').textContent = incoming;
}

// ── Pod Markers ──
function updatePodMarkers(pods) {
  for (const pod of pods) {
    let marker = podMarkers[pod.id];
    
    const stateClass = pod.state === POD_STATES.CHARGING ? 'charging'
      : pod.state === POD_STATES.HALTED ? 'halted'
      : pod.state === POD_STATES.ASSIGNED ? 'assigned'
      : pod.state === POD_STATES.IDLE ? 'idle' : 'active';
    
    if (!marker) {
      const icon = L.divIcon({
        className: 'pod-marker',
        html: `
          <div class="pod-marker-inner ${stateClass}" style="transform: rotate(${pod.heading || 0}deg)"></div>
          <div class="pod-label">${pod.id}</div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      marker = L.marker([pod.lat, pod.lng], { icon, zIndexOffset: 1000 }).addTo(map);
      podMarkers[pod.id] = marker;
    } else {
      marker.setLatLng([pod.lat, pod.lng]);
      const inner = marker.getElement()?.querySelector('.pod-marker-inner');
      if (inner) {
        inner.className = `pod-marker-inner ${stateClass}`;
        inner.style.transform = `rotate(${pod.heading || 0}deg)`;
      }
    }
  }
}

function updateObstacleMarkers(obstacles) {
  // Remove cleared obstacles
  for (const [id, marker] of Object.entries(obstacleMarkers)) {
    if (!obstacles.find(o => o.id === id)) {
      map.removeLayer(marker);
      delete obstacleMarkers[id];
    }
  }
  
  // Add new obstacles
  for (const obs of obstacles) {
    if (!obstacleMarkers[obs.id]) {
      const icon = L.divIcon({
        className: 'obstacle-marker',
        html: '⚠',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const marker = L.marker([obs.lat, obs.lng], { icon, zIndexOffset: 2000 }).addTo(map);
      marker.bindTooltip('⚠ Obstacle Detected', { direction: 'top', permanent: true, className: 'obstacle-tooltip' });
      obstacleMarkers[obs.id] = marker;
    }
  }
}

// ── Simulation ──
function initSimulation() {
  sim = new SimulationEngine();
  
  // Load first available network
  const firstNet = Object.keys(NETWORKS)[0];
  sim.loadNetwork(firstNet);
  renderNetwork(firstNet);
  
  sim.onUpdate = (pods, obstacles) => {
    updatePodMarkers(pods);
    updateObstacleMarkers(obstacles);
    updatePodList(pods);
    updateDashboard();
    updateRideTracker();
  };
  
  sim.onEvent = (evt) => {
    addEventToFeed(evt);
    addLogLine(evt);
  };
  
  sim.start();
}

// ── UI Binding ──
function initUI() {
  // Network selector
  const select = document.getElementById('network-select');
  for (const [id, net] of Object.entries(NETWORKS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = net.label;
    select.appendChild(opt);
  }
  select.addEventListener('change', (e) => {
    sim.stop();
    sim.loadNetwork(e.target.value);
    renderNetwork(e.target.value);
    populateStationSelects();
    sim.start();
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const tabId = tab.dataset.tab;
      document.getElementById(`panel-${tabId}`).classList.add('active');
      activeTab = tabId;
    });
  });

  // Play/Pause
  document.getElementById('btn-play-pause').addEventListener('click', () => {
    const running = sim.togglePause();
    document.getElementById('icon-play').style.display = running ? 'none' : 'block';
    document.getElementById('icon-pause').style.display = running ? 'block' : 'none';
  });
  // Show pause icon initially (sim starts running)
  document.getElementById('icon-play').style.display = 'none';
  document.getElementById('icon-pause').style.display = 'block';

  // Speed
  document.getElementById('btn-speed').addEventListener('click', () => {
    const speed = sim.cycleSpeed();
    document.getElementById('btn-speed').textContent = `${speed}×`;
  });

  // Obstacle
  document.getElementById('btn-obstacle').addEventListener('click', () => {
    sim.triggerObstacle();
  });

  // Deploy Pod
  document.getElementById('btn-add-pod').addEventListener('click', () => {
    sim.deployPod();
  });

  // Station popup close
  document.getElementById('popup-close').addEventListener('click', () => {
    document.getElementById('station-popup').style.display = 'none';
  });

  // Passenger booking
  populateStationSelects();
  
  const originSel = document.getElementById('origin-select');
  const destSel = document.getElementById('dest-select');
  const bookBtn = document.getElementById('btn-book');
  
  const updateBookBtn = () => {
    const canBook = originSel.value && destSel.value && originSel.value !== destSel.value;
    bookBtn.disabled = !canBook;
    
    if (canBook) {
      // Show fare estimate
      const origin = sim.graph.nodes.find(n => n.id === originSel.value);
      const dest = sim.graph.nodes.find(n => n.id === destSel.value);
      if (origin && dest) {
        const d = haversineUI(origin.lat, origin.lng, dest.lat, dest.lng);
        document.getElementById('fare-amount').textContent = `₹${Math.round(d * 12 + 15)}`;
        document.getElementById('eta-amount').textContent = `${Math.max(2, Math.round(d / 40 * 60))} min`;
        document.getElementById('dist-amount').textContent = `${d.toFixed(1)} km`;
        document.getElementById('fare-estimate').style.display = 'block';
      }
    } else {
      document.getElementById('fare-estimate').style.display = 'none';
    }
  };
  
  originSel.addEventListener('change', updateBookBtn);
  destSel.addEventListener('change', updateBookBtn);
  
  bookBtn.addEventListener('click', () => {
    console.log('[Booking] Requesting ride...', originSel.value, destSel.value);
    const womenOnly = document.getElementById('women-only').checked;
    const ride = sim.bookRide(originSel.value, destSel.value, womenOnly);
    if (ride) {
      console.log('[Booking] Success:', ride);
      document.getElementById('booking-form').style.display = 'none';
      document.getElementById('ride-tracker').style.display = 'block';
    } else {
      console.warn('[Booking] Failed: No pod found or route invalid');
      alert('No pods available right now. Please try again in a moment.');
    }
  });

  // Cancel ride
  document.getElementById('btn-cancel-ride').addEventListener('click', () => {
    sim.cancelRide();
    document.getElementById('booking-form').style.display = 'block';
    document.getElementById('ride-tracker').style.display = 'none';
  });

  // Initial RV graph render
  setInterval(drawRVGraph, 2000);
  setInterval(() => {
    // Fluctuate station demand
    for (const node of sim.graph.nodes) {
      node.demand = Math.max(0, Math.min(1, node.demand + (Math.random() - 0.5) * 0.1));
      node.waiting = Math.max(0, node.waiting + Math.floor((Math.random() - 0.4) * 2));
    }
  }, 5000);
}

function haversineUI(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function populateStationSelects() {
  const stations = sim.graph.nodes.filter(n => !n.isDepot);
  const originSel = document.getElementById('origin-select');
  const destSel = document.getElementById('dest-select');
  
  originSel.innerHTML = '<option value="">Select origin...</option>';
  destSel.innerHTML = '<option value="">Select destination...</option>';
  
  for (const s of stations) {
    originSel.innerHTML += `<option value="${s.id}">${s.name}</option>`;
    destSel.innerHTML += `<option value="${s.id}">${s.name}</option>`;
  }
}

// ── UI Updates ──
function updatePodList(pods) {
  if (activeTab !== 'simulation') return;
  
  const list = document.getElementById('pod-list');
  list.innerHTML = pods.map(pod => {
    const battClass = pod.battery < 20 ? 'low' : pod.battery < 50 ? 'medium' : '';
    const stateClass = pod.state === POD_STATES.CHARGING ? 'charging'
      : pod.state === POD_STATES.HALTED ? 'halted'
      : pod.state === POD_STATES.ASSIGNED ? 'assigned'
      : pod.state === POD_STATES.IDLE ? 'idle' : 'active';
    
    const statusText = pod.state === POD_STATES.CHARGING ? '⚡ Charging...'
      : pod.state === POD_STATES.HALTED ? '⚠ Halted'
      : pod.state === POD_STATES.ASSIGNED ? '🚖 Picking up pax'
      : pod.state === POD_STATES.IDLE ? '⏸ Idle'
      : `→ ${pod.speed.toFixed(0)} km/h`;
    
    return `
      <div class="pod-item" onclick="window._focusPod('${pod.id}')">
        <div class="pod-dot ${stateClass}"></div>
        <div class="pod-info">
          <div class="pod-name">${pod.id}${pod.womenOnly ? ' 👩' : ''}${pod.passengers ? ' 🧑' : ''}</div>
          <div class="pod-status">${statusText}</div>
        </div>
        <div class="pod-battery ${battClass}">${pod.battery.toFixed(0)}%</div>
      </div>
    `;
  }).join('');
}

// Global focus function
window._focusPod = (podId) => {
  const pod = sim.pods.find(p => p.id === podId);
  if (pod) map.flyTo([pod.lat, pod.lng], 15, { duration: 0.5 });
};

function addEventToFeed(evt) {
  const feed = document.getElementById('event-feed');
  const div = document.createElement('div');
  div.className = `event-item ${evt.type}`;
  div.innerHTML = `<span class="event-time">${evt.time}</span> ${evt.message}`;
  feed.insertBefore(div, feed.firstChild);
  
  // Keep max 20
  while (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

function addLogLine(evt) {
  const log = document.getElementById('system-log');
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="log-time">[${evt.time}]</span> <span class="log-msg">${evt.message}</span>`;
  log.insertBefore(div, log.firstChild);
  while (log.children.length > 30) log.removeChild(log.lastChild);
}

function updateDashboard() {
  if (activeTab !== 'dashboard') return;
  
  const stats = sim.getStats();
  document.getElementById('stat-active').textContent = stats.active;
  document.getElementById('stat-total').textContent = `/ ${sim.pods.length}`;
  document.getElementById('stat-passengers').textContent = stats.passengers;
  document.getElementById('stat-avg-battery').textContent = `${stats.avgBattery.toFixed(0)}%`;
  document.getElementById('stat-avg-speed').textContent = stats.avgSpeed.toFixed(0);

  // Rebalancing
  const rebalance = sim.getRebalanceData();
  const grid = document.getElementById('rebalance-grid');
  grid.innerHTML = rebalance.map(r => `
    <div class="rebalance-row">
      <span class="rebalance-station">${r.name}</span>
      <div class="rebalance-bar">
        <div class="rebalance-fill ${r.ratio > 0.6 ? 'high' : r.ratio > 0.3 ? 'med' : 'low'}" style="width:${r.ratio * 100}%"></div>
      </div>
      <span class="rebalance-action ${r.action === 'dispatch' ? 'dispatch' : r.action === 'surge' ? 'surge' : ''}">${r.action === 'dispatch' ? '🚀 Dispatch' : r.action === 'surge' ? '🔴 Surge' : '✅ Balanced'}</span>
    </div>
  `).join('');
}

function updateRideTracker() {
  if (!sim.rideRequest) return;
  
  const pod = sim.pods.find(p => p.id === sim.rideRequest.podId);
  if (!pod) return;
  
  const ride = pod.assignedRide;
  if (!ride) return;
  
  const statusEl = document.querySelector('#tracker-status span');
  const phaseValue = ride.phase;
  statusEl.textContent = phaseValue === 'pickup' ? 'Arriving...' : phaseValue === 'enroute' ? 'En Route' : 'Arrived!';
  
  document.getElementById('tracker-pod').textContent = pod.id;
  document.getElementById('tracker-battery').textContent = `${pod.battery.toFixed(0)}%`;
  document.getElementById('tracker-eta').textContent = `${Math.max(1, Math.round(sim.rideRequest.estimatedETA * (1 - ride.progress)))}m`;
  document.getElementById('tracker-speed').textContent = `${pod.speed.toFixed(0)}km/h`;
  document.getElementById('ride-progress').style.width = `${ride.progress * 100}%`;
  
  if (ride.phase === 'completed') {
    setTimeout(() => {
      document.getElementById('booking-form').style.display = 'block';
      document.getElementById('ride-tracker').style.display = 'none';
      sim.rideRequest = null;
    }, 4000);
  }
}

// ── RV Graph Canvas ──
function drawRVGraph() {
  const canvas = document.getElementById('rv-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
  ctx.fillRect(0, 0, W, H);
  
  const pods = sim.pods.slice(0, 8);
  const stations = sim.graph.nodes.filter(n => !n.isDepot).slice(0, 6);
  
  if (pods.length === 0 || stations.length === 0) return;
  
  // Draw pods on left, stations on right
  const podY = pods.map((_, i) => 20 + (H - 40) / (pods.length - 1 || 1) * i);
  const stY = stations.map((_, i) => 20 + (H - 40) / (stations.length - 1 || 1) * i);
  
  // Draw connections (RV edges)
  for (let i = 0; i < pods.length; i++) {
    for (let j = 0; j < stations.length; j++) {
      const d = haversineUI(pods[i].lat, pods[i].lng, stations[j].lat, stations[j].lng);
      if (d < 5) {
        const alpha = Math.max(0.08, 1 - d / 5);
        ctx.strokeStyle = `rgba(56, 189, 248, ${alpha})`;
        ctx.lineWidth = alpha * 2;
        ctx.beginPath();
        ctx.moveTo(60, podY[i]);
        ctx.bezierCurveTo(W/2, podY[i], W/2, stY[j], W - 60, stY[j]);
        ctx.stroke();
      }
    }
  }
  
  // Draw pod nodes
  for (let i = 0; i < pods.length; i++) {
    ctx.fillStyle = pods[i].state === POD_STATES.IDLE ? '#94a3b8' 
      : pods[i].state === POD_STATES.ASSIGNED ? '#818cf8' : '#38bdf8';
    ctx.beginPath();
    ctx.arc(60, podY[i], 6, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px JetBrains Mono';
    ctx.textAlign = 'right';
    ctx.fillText(pods[i].id, 48, podY[i] + 3);
  }
  
  // Draw station nodes
  for (let i = 0; i < stations.length; i++) {
    const demand = stations[i].demand;
    ctx.fillStyle = demand > 0.5 ? '#f87171' : demand > 0.25 ? '#fbbf24' : '#34d399';
    ctx.beginPath();
    ctx.arc(W - 60, stY[i], 6, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px Inter';
    ctx.textAlign = 'left';
    const name = stations[i].name.length > 12 ? stations[i].name.slice(0, 12) + '..' : stations[i].name;
    ctx.fillText(name, W - 48, stY[i] + 3);
  }
  
  // Labels
  ctx.fillStyle = '#64748b';
  ctx.font = '10px Inter';
  ctx.textAlign = 'center';
  ctx.fillText('Pods', 60, H - 4);
  ctx.fillText('Demand', W - 60, H - 4);
}
