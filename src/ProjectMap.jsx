import React, { useEffect, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import './map.css';

const DEFAULT_CENTER = [51.5074, -0.1278];
const TARGET_BOUNDS = {
  minLatitude: 50.35,
  maxLatitude: 52.45,
  minLongitude: -2.15,
  maxLongitude: 1.95,
};

function coordinates(project) {
  const latitude = Number(project.Latitude);
  const longitude = Number(project.Longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? [latitude, longitude]
    : null;
}

function isInTargetBounds([latitude, longitude]) {
  return latitude >= TARGET_BOUNDS.minLatitude
    && latitude <= TARGET_BOUNDS.maxLatitude
    && longitude >= TARGET_BOUNDS.minLongitude
    && longitude <= TARGET_BOUNDS.maxLongitude;
}

function markerIcon({ selected, saved, isNew }) {
  const state = selected ? 'selected' : saved ? 'saved' : isNew ? 'new' : 'default';
  return L.divIcon({
    className: 'site-map-marker-shell',
    html: `<span class="site-map-marker ${state}" aria-hidden="true"><i></i></span>`,
    iconSize: [30, 38],
    iconAnchor: [15, 36],
    tooltipAnchor: [0, -30],
  });
}

function clusterIcon(cluster) {
  const count = cluster.getChildCount();
  const size = count >= 100 ? 'large' : count >= 25 ? 'medium' : 'small';
  const tone = count >= 50 ? 'orange' : 'navy';
  return L.divIcon({
    className: 'site-map-cluster-shell',
    html: `<span class="site-map-cluster ${size} ${tone}">${count.toLocaleString('en-GB')}</span>`,
    iconSize: [48, 48],
  });
}

function tooltipContent(project) {
  const root = document.createElement('div');
  root.className = 'site-map-tooltip';

  const name = document.createElement('strong');
  name.textContent = project.Name || 'Unnamed project';
  root.append(name);

  const contractor = document.createElement('span');
  contractor.textContent = project.MainContractor || 'Contractor not published';
  root.append(contractor);

  return root;
}

function ClusterLayer({ projects, selectedId, saved, history, onSelect }) {
  const map = useMap();

  useEffect(() => {
    const group = L.markerClusterGroup({
      chunkedLoading: true,
      chunkInterval: 50,
      chunkDelay: 10,
      maxClusterRadius: 46,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      iconCreateFunction: clusterIcon,
    });

    for (const project of projects) {
      const position = coordinates(project);
      if (!position) continue;
      const meta = history[project.Id];
      const isNew = Boolean(meta?.discovered_after_baseline)
        && Date.now() - new Date(meta.first_seen_at).getTime() <= 7 * 86_400_000;
      const marker = L.marker(position, {
        icon: markerIcon({
          selected: selectedId === project.Id,
          saved: saved.has(project.Id),
          isNew,
        }),
        title: project.Name || 'CCS project',
        keyboard: true,
      });
      marker.bindTooltip(tooltipContent(project), {
        direction: 'top',
        opacity: 1,
        offset: [0, -4],
      });
      marker.on('click', () => onSelect(project));
      group.addLayer(marker);
    }

    map.addLayer(group);
    return () => map.removeLayer(group);
  }, [history, map, onSelect, projects, saved, selectedId]);

  return null;
}

function FitResults({ projects, request }) {
  const map = useMap();
  const bounds = useMemo(() => {
    // A small number of upstream CCS markers have incorrect coordinates.
    // Excluding geographic outliers from auto-fit keeps the useful target
    // region visible without deleting or silently changing source records.
    const points = projects.map(coordinates).filter(point => point && isInTargetBounds(point));
    return points.length ? L.latLngBounds(points) : null;
  }, [projects]);

  useEffect(() => {
    if (!bounds) {
      map.setView(DEFAULT_CENTER, 8);
      return;
    }
    map.fitBounds(bounds, {
      padding: [42, 42],
      maxZoom: 13,
      animate: false,
    });
  }, [bounds, map, request]);

  return null;
}

export default function ProjectMap({
  projects,
  selected,
  saved,
  history,
  onSelect,
  fitRequest,
}) {
  const mappedProjects = useMemo(
    () => projects.filter(project => coordinates(project)),
    [projects],
  );

  return (
    <div className="project-map" aria-label="Project locations map">
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={8}
        minZoom={6}
        maxZoom={18}
        scrollWheelZoom
        zoomControl
        preferCanvas
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClusterLayer
          projects={mappedProjects}
          selectedId={selected?.Id}
          saved={saved}
          history={history}
          onSelect={onSelect}
        />
        <FitResults projects={mappedProjects} request={fitRequest} />
      </MapContainer>
      {mappedProjects.length === 0 ? (
        <div className="map-empty">
          <strong>No mapped projects found</strong>
          <span>Try clearing a filter or changing your search.</span>
        </div>
      ) : null}
    </div>
  );
}
