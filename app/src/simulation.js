// ═══════════════════════════════════════════════════════
// Simulation Engine — Pod Transit Digital Twin
// Dijkstra routing, battery management, platooning, obstacles
// ═══════════════════════════════════════════════════════

import { NETWORKS } from './routes-data.js';

// ── Utility ──
const uid = () => crypto.randomUUID().slice(0, 8);
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2);
const haversine = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

// Pod states
export const POD_STATES = {
  IDLE: 'idle',
  MOVING: 'active',
  ASSIGNED: 'assigned',
  CHARGING: 'charging',
  HALTED: 'halted',
};

export class SimulationEngine {
  constructor() {
    this.pods = [];
    this.obstacles = [];
    this.events = [];
    this.network = null;
    this.networkId = null;
    this.graph = { nodes: [], edges: [] };
    this.running = false;
    this.speed = 1;
    this.lastTime = 0;
    this.onUpdate = null;
    this.onEvent = null;
    this.rideRequest = null;
    this.podIdCounter = 1;
  }

  // ── Load Network ──
  loadNetwork(networkId) {
    this.networkId = networkId;
    this.network = NETWORKS[networkId];
    if (!this.network) return;
    
    this._buildGraph();
    this._spawnPods();
    this._emitEvent('info', `Network loaded: ${this.network.label}`);
    this._emitEvent('info', `${this.graph.nodes.length} stations, ${this.graph.edges.length} edges, ${this.pods.length} pods deployed`);
  }

  // ── Build Graph from Routes ──
  _buildGraph() {
    const nodes = [];
    const edges = [];
    const nodeMap = new Map();
    
    // Stations as nodes
    for (const station of this.network.stations) {
      const key = `${station.lat.toFixed(4)},${station.lng.toFixed(4)}`;
      if (!nodeMap.has(key)) {
        const node = { 
          id: uid(), 
          name: station.name, 
          lat: station.lat, 
          lng: station.lng,
          key,
          isDepot: station.name.toLowerCase().includes('depot') || station.name.toLowerCase().includes('charging'),
          demand: Math.random() * 0.7,
          waiting: Math.floor(Math.random() * 8),
        };
        nodeMap.set(key, node);
        nodes.push(node);
      }
    }
    
    // Mark some stations as depots (at least 1 per network)
    if (!nodes.some(n => n.isDepot) && nodes.length > 2) {
      nodes[nodes.length - 1].isDepot = true;
      nodes[nodes.length - 1].name = '⚡ Depot ' + nodes[nodes.length - 1].name;
    }
    
    // Routes as edges
    for (const route of this.network.routes) {
      const start = route.coords[0];
      const end = route.coords[route.coords.length - 1];
      
      const startKey = `${start[0].toFixed(4)},${start[1].toFixed(4)}`;
      const endKey = `${end[0].toFixed(4)},${end[1].toFixed(4)}`;
      
      const startNode = nodeMap.get(startKey);
      const endNode = nodeMap.get(endKey);
      
      if (startNode && endNode && startNode !== endNode) {
        const distance = route.coords.reduce((sum, pt, i) => {
          if (i === 0) return 0;
          return sum + haversine(route.coords[i-1][0], route.coords[i-1][1], pt[0], pt[1]);
        }, 0);
        
        edges.push({
          id: uid(),
          from: startNode.id,
          to: endNode.id,
          name: route.name,
          coords: route.coords,
          distance: Math.round(distance * 100) / 100,
          blocked: false,
        });
        
        // Bidirectional
        edges.push({
          id: uid(),
          from: endNode.id,
          to: startNode.id,
          name: route.name + ' (rev)',
          coords: [...route.coords].reverse(),
          distance: Math.round(distance * 100) / 100,
          blocked: false,
        });
      }
    }
    
    this.graph = { nodes, edges, nodeMap };
  }

  // ── Dijkstra's Shortest Path ──
  dijkstra(fromNodeId, toNodeId) {
    const { nodes, edges } = this.graph;
    const distances = {};
    const prev = {};
    const visited = new Set();
    const queue = [];
    
    for (const n of nodes) {
      distances[n.id] = Infinity;
      prev[n.id] = null;
    }
    distances[fromNodeId] = 0;
    queue.push({ id: fromNodeId, dist: 0 });
    
    while (queue.length > 0) {
      queue.sort((a, b) => a.dist - b.dist);
      const current = queue.shift();
      
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      
      if (current.id === toNodeId) break;
      
      const outEdges = edges.filter(e => e.from === current.id && !e.blocked);
      for (const edge of outEdges) {
        const newDist = distances[current.id] + edge.distance;
        if (newDist < distances[edge.to]) {
          distances[edge.to] = newDist;
          prev[edge.to] = { nodeId: current.id, edge };
          queue.push({ id: edge.to, dist: newDist });
        }
      }
    }
    
    if (distances[toNodeId] === Infinity) return null;
    
    // Reconstruct path
    const path = [];
    let current = toNodeId;
    while (prev[current]) {
      path.unshift(prev[current].edge);
      current = prev[current].nodeId;
    }
    
    return { edges: path, totalDistance: distances[toNodeId] };
  }

  // ── Spawn Pods ──
  _spawnPods() {
    this.pods = [];
    const numPods = Math.min(Math.max(5, Math.floor(this.graph.nodes.length / 3)), 15);
    
    for (let i = 0; i < numPods; i++) {
      const node = this.graph.nodes[i % this.graph.nodes.length];
      this.pods.push({
        id: `P${String(this.podIdCounter++).padStart(2, '0')}`,
        state: POD_STATES.IDLE,
        battery: 60 + Math.random() * 40,
        speed: 30 + Math.random() * 20, // km/h
        lat: node.lat,
        lng: node.lng,
        currentNodeId: node.id,
        targetNodeId: null,
        path: [],
        pathIndex: 0,
        edgeProgress: 0,
        currentEdge: null,
        womenOnly: i === numPods - 1,
        passengers: 0,
        totalDistance: 0,
        assignedRide: null,
      });
    }
    
    // Give one pod low battery to demo charging behavior
    if (this.pods.length > 2) {
      this.pods[2].battery = 15;
    }
  }

  // ── Deploy New Pod ──
  deployPod() {
    if (this.graph.nodes.length === 0) return;
    const node = this.graph.nodes[Math.floor(Math.random() * this.graph.nodes.length)];
    const pod = {
      id: `P${String(this.podIdCounter++).padStart(2, '0')}`,
      state: POD_STATES.IDLE,
      battery: 90 + Math.random() * 10,
      speed: 30 + Math.random() * 20,
      lat: node.lat,
      lng: node.lng,
      currentNodeId: node.id,
      targetNodeId: null,
      path: [],
      pathIndex: 0,
      edgeProgress: 0,
      currentEdge: null,
      womenOnly: false,
      passengers: 0,
      totalDistance: 0,
      assignedRide: null,
    };
    this.pods.push(pod);
    this._emitEvent('success', `Pod ${pod.id} deployed at ${node.name}`);
    return pod;
  }

  // ── Trigger Obstacle ──
  triggerObstacle() {
    const activeEdges = this.graph.edges.filter(e => !e.blocked);
    if (activeEdges.length === 0) return;
    
    const edge = activeEdges[Math.floor(Math.random() * activeEdges.length)];
    const midCoord = edge.coords[Math.floor(edge.coords.length / 2)];
    
    // Block this edge and its reverse
    edge.blocked = true;
    const reverse = this.graph.edges.find(e => e.from === edge.to && e.to === edge.from && !e.blocked);
    if (reverse) reverse.blocked = true;
    
    const obstacle = {
      id: uid(),
      lat: midCoord[0],
      lng: midCoord[1],
      edgeId: edge.id,
      created: Date.now(),
    };
    this.obstacles.push(obstacle);
    
    // Halt pods on this edge
    for (const pod of this.pods) {
      if (pod.currentEdge && (pod.currentEdge.id === edge.id || (reverse && pod.currentEdge.id === reverse.id))) {
        pod.state = POD_STATES.HALTED;
        this._emitEvent('danger', `⚠️ Pod ${pod.id} HALTED — obstacle on ${edge.name}`);
      }
    }
    
    this._emitEvent('danger', `🚧 Obstacle detected on ${edge.name}!`);
    
    // Auto-clear after 10 seconds
    setTimeout(() => {
      edge.blocked = false;
      if (reverse) reverse.blocked = false;
      this.obstacles = this.obstacles.filter(o => o.id !== obstacle.id);
      
      for (const pod of this.pods) {
        if (pod.state === POD_STATES.HALTED) {
          pod.state = POD_STATES.MOVING;
          this._emitEvent('success', `✅ Pod ${pod.id} resuming — obstacle cleared`);
        }
      }
      this._emitEvent('info', `Obstacle cleared on ${edge.name}`);
    }, 10000);
    
    return obstacle;
  }

  // ── Book Ride ──
  bookRide(originNodeId, destNodeId, womenOnly = false) {
    // Find available pod
    let pod = null;
    const candidates = this.pods.filter(p => 
      p.state === POD_STATES.IDLE && 
      p.battery > 25 &&
      (!womenOnly || p.womenOnly)
    );
    
    if (candidates.length === 0) {
      this._emitEvent('warning', '⚠️ No pods available for ride request');
      return null;
    }
    
    // Find closest pod
    const originNode = this.graph.nodes.find(n => n.id === originNodeId);
    if (!originNode) return null;
    
    let bestDist = Infinity;
    for (const c of candidates) {
      const d = haversine(c.lat, c.lng, originNode.lat, originNode.lng);
      if (d < bestDist) {
        bestDist = d;
        pod = c;
      }
    }
    
    // Route pod to origin, then to destination
    const routeToOrigin = this.dijkstra(pod.currentNodeId, originNodeId);
    const routeToDest = this.dijkstra(originNodeId, destNodeId);
    
    if (!routeToOrigin || !routeToDest) {
      this._emitEvent('warning', '⚠️ No viable route found');
      return null;
    }
    
    pod.state = POD_STATES.ASSIGNED;
    pod.assignedRide = {
      originNodeId,
      destNodeId,
      phase: 'pickup', // pickup -> enroute -> completed
      pickupPath: routeToOrigin.edges,
      destPath: routeToDest.edges,
      totalDistance: routeToOrigin.totalDistance + routeToDest.totalDistance,
      progress: 0,
    };
    pod.path = routeToOrigin.edges;
    pod.pathIndex = 0;
    pod.edgeProgress = 0;
    pod.currentEdge = null;
    
    const destNode = this.graph.nodes.find(n => n.id === destNodeId);
    this._emitEvent('success', `🚖 Pod ${pod.id} assigned! Heading to pick you up`);
    
    this.rideRequest = {
      podId: pod.id,
      originNodeId,
      destNodeId,
      originName: originNode.name,
      destName: destNode ? destNode.name : 'Destination',
      estimatedDistance: routeToOrigin.totalDistance + routeToDest.totalDistance,
      estimatedFare: Math.round((routeToOrigin.totalDistance + routeToDest.totalDistance) * 12 + 15),
      estimatedETA: Math.round((routeToOrigin.totalDistance + routeToDest.totalDistance) / 40 * 60),
    };
    
    return this.rideRequest;
  }

  cancelRide() {
    if (!this.rideRequest) return;
    const pod = this.pods.find(p => p.id === this.rideRequest.podId);
    if (pod) {
      pod.state = POD_STATES.IDLE;
      pod.assignedRide = null;
      pod.path = [];
      pod.passengers = 0;
    }
    this._emitEvent('warning', `Ride cancelled`);
    this.rideRequest = null;
  }

  // ── Start / Stop ──
  start() { 
    this.running = true; 
    this.lastTime = performance.now();
    this._tick();
  }
  
  stop() { this.running = false; }
  
  togglePause() {
    if (this.running) this.stop();
    else this.start();
    return this.running;
  }

  cycleSpeed() {
    const speeds = [1, 2, 4, 8];
    const idx = speeds.indexOf(this.speed);
    this.speed = speeds[(idx + 1) % speeds.length];
    return this.speed;
  }

  // ── Main Loop ──
  _tick() {
    if (!this.running) return;
    
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1) * this.speed;
    this.lastTime = now;
    
    for (const pod of this.pods) {
      this._updatePod(pod, dt);
    }
    
    if (this.onUpdate) this.onUpdate(this.pods, this.obstacles);
    
    requestAnimationFrame(() => this._tick());
  }

  _updatePod(pod, dt) {
    // Battery drain
    if (pod.state === POD_STATES.MOVING || pod.state === POD_STATES.ASSIGNED) {
      pod.battery = Math.max(0, pod.battery - dt * 0.08);
    }
    
    // Charging
    if (pod.state === POD_STATES.CHARGING) {
      pod.battery = Math.min(100, pod.battery + dt * 2.5);
      if (pod.battery >= 98) {
        pod.state = POD_STATES.IDLE;
        pod.battery = 100;
        this._emitEvent('success', `🔋 Pod ${pod.id} fully charged!`);
      }
      return;
    }
    
    // Halted - do nothing
    if (pod.state === POD_STATES.HALTED) return;
    
    // Low battery - route to depot
    if (pod.battery < 18 && pod.state !== POD_STATES.ASSIGNED && pod.state !== POD_STATES.CHARGING) {
      const depots = this.graph.nodes.filter(n => n.isDepot);
      if (depots.length > 0) {
        let bestDepot = depots[0];
        let bestDist = Infinity;
        for (const depot of depots) {
          const d = haversine(pod.lat, pod.lng, depot.lat, depot.lng);
          if (d < bestDist) { bestDist = d; bestDepot = depot; }
        }
        
        const route = this.dijkstra(pod.currentNodeId, bestDepot.id);
        if (route) {
          pod.path = route.edges;
          pod.pathIndex = 0;
          pod.edgeProgress = 0;
          pod.currentEdge = null;
          pod.state = POD_STATES.MOVING;
          pod.targetNodeId = bestDepot.id;
          this._emitEvent('warning', `🔋 Pod ${pod.id} low battery (${pod.battery.toFixed(0)}%) — heading to depot`);
        }
      }
    }
    
    // Move along path
    if (pod.path.length > 0) {
      if (!pod.currentEdge) {
        if (pod.pathIndex < pod.path.length) {
          pod.currentEdge = pod.path[pod.pathIndex];
          pod.edgeProgress = 0;
        } else {
          // Path complete
          this._onPathComplete(pod);
          return;
        }
      }
      
      if (pod.currentEdge) {
        // Check if edge is blocked
        if (pod.currentEdge.blocked) {
          pod.state = POD_STATES.HALTED;
          this._emitEvent('danger', `⚠️ Pod ${pod.id} stopped — track blocked`);
          return;
        }
        
        const edge = pod.currentEdge;
        const speedFactor = (pod.speed / 3600) / (edge.distance || 0.1);
        pod.edgeProgress += dt * speedFactor;
        
        if (pod.edgeProgress >= 1) {
          // Edge complete
          pod.edgeProgress = 1;
          const lastCoord = edge.coords[edge.coords.length - 1];
          pod.lat = lastCoord[0];
          pod.lng = lastCoord[1];
          
          // Update current node
          const arrivedNode = this.graph.nodes.find(n => n.id === edge.to);
          if (arrivedNode) pod.currentNodeId = arrivedNode.id;
          
          pod.pathIndex++;
          pod.currentEdge = null;
          pod.totalDistance += edge.distance;
        } else {
          // Interpolate position along edge
          const totalPts = edge.coords.length;
          const exactIdx = pod.edgeProgress * (totalPts - 1);
          const idx = Math.floor(exactIdx);
          const frac = exactIdx - idx;
          
          if (idx < totalPts - 1) {
            pod.lat = lerp(edge.coords[idx][0], edge.coords[idx + 1][0], frac);
            pod.lng = lerp(edge.coords[idx][1], edge.coords[idx + 1][1], frac);
          }
        }
        
        if (pod.state === POD_STATES.IDLE) pod.state = POD_STATES.MOVING;
      }
    } else if (pod.state === POD_STATES.IDLE || pod.state === POD_STATES.MOVING) {
      // Idle wandering — pick random adjacent node
      pod.state = POD_STATES.IDLE;
      if (Math.random() < 0.005 * this.speed) {
        const outEdges = this.graph.edges.filter(e => e.from === pod.currentNodeId && !e.blocked);
        if (outEdges.length > 0) {
          const edge = outEdges[Math.floor(Math.random() * outEdges.length)];
          pod.path = [edge];
          pod.pathIndex = 0;
          pod.edgeProgress = 0;
          pod.currentEdge = null;
          pod.state = POD_STATES.MOVING;
        }
      }
    }
    
    // Update ride progress
    if (pod.assignedRide) {
      const ride = pod.assignedRide;
      if (ride.phase === 'pickup') {
        const totalEdges = ride.pickupPath.length + ride.destPath.length;
        ride.progress = totalEdges > 0 ? (pod.pathIndex + pod.edgeProgress) / totalEdges : 0;
      } else if (ride.phase === 'enroute') {
        const totalEdges = ride.pickupPath.length + ride.destPath.length;
        const doneEdges = ride.pickupPath.length;
        ride.progress = totalEdges > 0 ? (doneEdges + pod.pathIndex + pod.edgeProgress) / totalEdges : 0;
      }
    }
  }

  _onPathComplete(pod) {
    pod.path = [];
    pod.currentEdge = null;
    
    // Check if at depot
    const node = this.graph.nodes.find(n => n.id === pod.currentNodeId);
    if (node && node.isDepot && pod.battery < 50) {
      pod.state = POD_STATES.CHARGING;
      this._emitEvent('info', `⚡ Pod ${pod.id} docked at ${node.name} — charging`);
      return;
    }
    
    // Handle ride assignment
    if (pod.assignedRide) {
      const ride = pod.assignedRide;
      if (ride.phase === 'pickup') {
        ride.phase = 'enroute';
        pod.passengers = 1;
        pod.path = ride.destPath;
        pod.pathIndex = 0;
        pod.edgeProgress = 0;
        pod.currentEdge = null;
        this._emitEvent('success', `🚀 Passenger picked up! Pod ${pod.id} en route to destination`);
      } else if (ride.phase === 'enroute') {
        ride.phase = 'completed';
        ride.progress = 1;
        pod.passengers = 0;
        pod.state = POD_STATES.IDLE;
        pod.assignedRide = null;
        this.rideRequest = null;
        this._emitEvent('success', `🎉 Ride complete! Pod ${pod.id} arrived at destination`);
      }
    } else {
      pod.state = POD_STATES.IDLE;
    }
  }

  // ── Stats ──
  getStats() {
    const active = this.pods.filter(p => p.state === POD_STATES.MOVING || p.state === POD_STATES.ASSIGNED).length;
    const passengers = this.pods.reduce((s, p) => s + p.passengers, 0);
    const avgBattery = this.pods.reduce((s, p) => s + p.battery, 0) / (this.pods.length || 1);
    const avgSpeed = this.pods.filter(p => p.state === POD_STATES.MOVING).reduce((s, p) => s + p.speed, 0) / 
                     (this.pods.filter(p => p.state === POD_STATES.MOVING).length || 1);
    
    return { active, passengers, avgBattery, avgSpeed, total: this.pods.length };
  }

  getRebalanceData() {
    const stations = this.graph.nodes.filter(n => !n.isDepot).slice(0, 8);
    return stations.map(s => {
      const nearbyPods = this.pods.filter(p => haversine(p.lat, p.lng, s.lat, s.lng) < 2).length;
      const demand = s.waiting + Math.floor(s.demand * 5);
      const surplus = nearbyPods - Math.ceil(demand / 3);
      return {
        name: s.name,
        demand,
        supply: nearbyPods,
        action: surplus < -1 ? 'dispatch' : surplus > 1 ? 'balanced' : demand > 4 ? 'surge' : 'balanced',
        ratio: Math.min(1, demand / 8),
      };
    });
  }

  // ── Events ──
  _emitEvent(type, message) {
    const evt = {
      id: uid(),
      type,
      message,
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    this.events.unshift(evt);
    if (this.events.length > 50) this.events.pop();
    if (this.onEvent) this.onEvent(evt);
  }
}
