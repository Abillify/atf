{{/*
Shared helpers for the ATF service subcharts (requirement 12.3).

Every helper takes a dict. The convention throughout the chart:

  dict "ctx" . "name" "<component>"

where "ctx" is the subchart root context (whose .Values IS the component
block, e.g. the parent's `runtime:` values) and "name" is the component
short name (runtime, gate, search, extract, control). Object names derive
from the release name alone, so cross-subchart references (for example the
Extract chart pointing at the Search Service) resolve without any single
chart owning the naming.
*/}}

{{- define "atf.name" -}}
{{- .ctx.Values.global.nameOverride | default .ctx.Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Full object name for one component: "<release>-<component>", lowercased so a
release name with dots or capitals still produces a valid RFC 1123 name.
*/}}
{{- define "atf.fullname" -}}
{{- if .ctx.Values.global.fullnameOverride -}}
{{- printf "%s-%s" .ctx.Values.global.fullnameOverride .name | lower | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .ctx.Release.Name .name | lower | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "atf.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "atf.selectorLabels" -}}
app.kubernetes.io/name: {{ include "atf.name" (dict "ctx" .ctx) }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .name }}
{{- end -}}

{{- define "atf.labels" -}}
helm.sh/chart: {{ include "atf.chart" .ctx }}
{{ include "atf.selectorLabels" . }}
app.kubernetes.io/part-of: atf
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
{{- end -}}

{{- define "atf.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- .Values.serviceAccount.name | default (include "atf.fullname" (dict "ctx" .ctx "name" .Component)) | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- required (printf "%s: serviceAccount.name is required when serviceAccount.create is false" .Component) .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Image reference: "<registry>/<repository>@<digest>" when a digest is pinned,
"<registry>/<repository>:<tag>" otherwise. The tag falls back to the chart's
appVersion, so a released chart always names a released product version.
*/}}
{{- define "atf.image" -}}
{{- $registry := .ctx.Values.global.image.registry -}}
{{- if .digest -}}
{{- printf "%s/%s@%s" $registry .repository .digest -}}
{{- else -}}
{{- $tag := .ctx.Values.global.image.tag | default .ctx.Chart.AppVersion -}}
{{- printf "%s/%s:%s" $registry .repository $tag -}}
{{- end -}}
{{- end -}}

{{/*
Pod-level security context. 65532:65532 is the unprivileged user baked into
every ATF image (deploy/images/Dockerfile.*); fsGroup makes the emptyDir
volumes writable for it under readOnlyRootFilesystem.
*/}}
{{- define "atf.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
fsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/*
Container-level security context. The read-only root filesystem is paired
with the /tmp emptyDir every ATF pod mounts (see atf.volumes).
*/}}
{{- define "atf.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end -}}

{{/*
In-cluster URL of a component's Service, used for the wiring the chart owns
(Control -> Runtime, Extract -> Search). The port defaults to 80, the
chart's fixed internal Service port; pass "port" explicitly to override.
*/}}
{{- define "atf.serviceURL" -}}
{{- $port := .port | default 80 -}}
{{- $scheme := .scheme | default "http" -}}
{{- printf "%s://%s.%s.svc.cluster.local:%v" $scheme (include "atf.fullname" (dict "ctx" .ctx "name" .name)) .ctx.Release.Namespace $port -}}
{{- end -}}

{{/*
Environment every ATF service needs regardless of operator configuration.
Service-specific required variables (embedding endpoints, vision models,
database credentials) arrive through extraEnv and the existing-Secret
reference; this helper only sets what the chart itself owns. The Gate is
deliberately excluded from PORT: it listens on server.port from its mounted
config.yaml (MCPGATE_CONFIG_DIR), not on an environment variable.
*/}}
{{- define "atf.defaultEnv" -}}
{{- if ne .Component "gate" }}
- name: PORT
  value: {{ .Values.containerPort | quote }}
{{- end }}
{{- if eq .Component "runtime" }}
- name: APP_ENV
  value: {{ .Values.config.appEnv | quote }}
- name: MIGRATE_ON_START
  value: "false"
{{- with .Values.flowsConfigMap }}
- name: FLOWS_DIR
  value: /config/flows
{{- end }}
{{- end }}
{{- if or (eq .Component "search") (eq .Component "extract") }}
- name: MIGRATE_ON_START
  value: "false"
{{- with .Values.config.tls }}{{- if .secretName }}
# Direct service TLS (requirement 11.8): the PEM pair comes from an existing
# kubernetes.io/tls Secret mounted read-only at /etc/atf/tls (see the
# per-service deployment template). The chart wires the env vars and the
# HTTPS probes; the workload itself terminates TLS.
- name: TLS_CERT_FILE
  value: /etc/atf/tls/tls.crt
- name: TLS_KEY_FILE
  value: /etc/atf/tls/tls.key
{{- end }}{{- end }}
{{- end }}
{{- if eq .Component "extract" }}
{{- if .Values.config.autoSearchUrl }}
- name: SEARCH_URL
  value: {{ include "atf.serviceURL" (dict "ctx" .ctx "name" "search" "scheme" (ternary "https" "http" .Values.config.searchTls)) | quote }}
{{- end }}
{{- end }}
{{- if eq .Component "gate" }}
{{- with .Values.configMap }}
- name: MCPGATE_CONFIG_DIR
  value: /config
{{- end }}
- name: MCPGATE_ENV
  value: {{ .Values.config.env | quote }}
{{- end }}
{{- if eq .Component "control" }}
{{- if .Values.config.autoBackendUrl }}
- name: NEXT_PUBLIC_BACKEND_URL
  value: {{ include "atf.serviceURL" (dict "ctx" .ctx "name" "runtime") | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
The always-present volumes: a writable /tmp under the read-only root
filesystem (Extract's LibreOffice needs HOME-writable scratch space; the
Extract image sets its user home to /tmp, so the same emptyDir covers it).
tmpSizeLimit optionally caps the emptyDir (defaults to the node's
ephemeral-storage limits).
*/}}
{{- define "atf.volumes" -}}
- name: tmp
  emptyDir:
    {{- with .Values.tmpSizeLimit }}
    sizeLimit: {{ . }}
    {{- else }}
    {}
    {{- end }}
{{- end -}}

{{- define "atf.volumeMounts" -}}
- name: tmp
  mountPath: /tmp
{{- end -}}

{{/*
Rendering of the common Deployment. Parameters (dict):
  ctx              subchart root context
  name             component name
  livenessPath     liveness probe path
  readinessPath    readiness probe path
  extraVolumes     optional additional volume specs (YAML string)
  extraMounts      optional additional volumeMount specs (YAML string)
*/}}
{{- define "atf.deployment" -}}
{{- $ctx := .ctx -}}
{{- $c := .name -}}
{{- $root := dict "ctx" $ctx "Component" $c "Values" $ctx.Values -}}
{{/* Direct service TLS flips the kubelet probes to HTTPS (kubelet does not
verify probe certificates, so no CA wiring is needed here). Client
verification (TLS_CLIENT_CA_FILE) is deliberately NOT wired by the chart:
kubelet httpGet probes cannot present client certificates, so enabling mTLS
on the probe port would fail every probe — see DEPLOYMENT.md. */}}
{{- $probeScheme := "HTTP" -}}
{{- with $ctx.Values.config.tls -}}
{{- if .secretName -}}
{{- $probeScheme = "HTTPS" -}}
{{- end -}}
{{- end -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "atf.fullname" (dict "ctx" $ctx "name" $c) }}
  labels:
    {{- include "atf.labels" (dict "ctx" $ctx "name" $c) | nindent 4 }}
spec:
  revisionHistoryLimit: 3
  {{- if not $ctx.Values.autoscaling.enabled }}
  replicas: {{ $ctx.Values.replicaCount }}
  {{- end }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      {{- include "atf.selectorLabels" (dict "ctx" $ctx "name" $c) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "atf.selectorLabels" (dict "ctx" $ctx "name" $c) | nindent 8 }}
      {{- if or $ctx.Values.global.podAnnotations $ctx.Values.podAnnotations }}
      annotations:
        {{- with $ctx.Values.global.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
        {{- with $ctx.Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      {{- end }}
    spec:
      serviceAccountName: {{ include "atf.serviceAccountName" $root }}
      automountServiceAccountToken: false
      securityContext:
        {{- include "atf.podSecurityContext" $ctx | nindent 8 }}
      {{- with $ctx.Values.global.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $ctx.Values.nodeSelector | default $ctx.Values.global.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $ctx.Values.tolerations | default $ctx.Values.global.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $ctx.Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- else }}{{- with $ctx.Values.global.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}{{- end }}
      {{- with $ctx.Values.global.topologySpreadConstraints }}
      topologySpreadConstraints:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: {{ $c }}
          image: {{ include "atf.image" (dict "ctx" $ctx "repository" $ctx.Values.image.repository "digest" $ctx.Values.image.digest) | quote }}
          imagePullPolicy: {{ $ctx.Values.image.pullPolicy | default $ctx.Values.global.image.pullPolicy }}
          securityContext:
            {{- include "atf.containerSecurityContext" $ctx | nindent 12 }}
          ports:
            - name: http
              containerPort: {{ $ctx.Values.containerPort }}
          env:
            {{- include "atf.defaultEnv" $root | trim | nindent 12 }}
            {{- with $ctx.Values.extraEnv }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          {{- $secretName := index $ctx.Values.global.secrets $c | default "" }}
          {{- if or $secretName $ctx.Values.extraEnvFrom }}
          envFrom:
            {{- if $secretName }}
            - secretRef:
                name: {{ $secretName | quote }}
            {{- end }}
            {{- with $ctx.Values.extraEnvFrom }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          {{- end }}
          livenessProbe:
            httpGet:
              path: {{ .livenessPath }}
              port: http
              scheme: {{ $probeScheme }}
            initialDelaySeconds: 15
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 6
          readinessProbe:
            httpGet:
              path: {{ .readinessPath }}
              port: http
              scheme: {{ $probeScheme }}
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            requests:
              {{- toYaml $ctx.Values.resources.requests | nindent 14 }}
            limits:
              {{- toYaml $ctx.Values.resources.limits | nindent 14 }}
          volumeMounts:
            {{- include "atf.volumeMounts" $ctx | nindent 12 }}
            {{- with .extraMounts }}
            {{- . | nindent 12 }}
            {{- end }}
      volumes:
        {{- include "atf.volumes" $ctx | nindent 8 }}
        {{- with .extraVolumes }}
        {{- . | nindent 8 }}
        {{- end }}
{{- end -}}

{{/*
Service for one component. ClusterIP by default; the port defaults to 80 so
the cross-service URLs the chart generates stay short and stable (see the
note on atf.serviceURL about changing it).
*/}}
{{- define "atf.service" -}}
{{- $ctx := .ctx -}}
{{- $c := .name -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "atf.fullname" (dict "ctx" $ctx "name" $c) }}
  labels:
    {{- include "atf.labels" (dict "ctx" $ctx "name" $c) | nindent 4 }}
spec:
  type: {{ $ctx.Values.service.type | default "ClusterIP" }}
  ports:
    - name: http
      port: {{ $ctx.Values.service.port | default 80 }}
      targetPort: http
      protocol: TCP
  selector:
    {{- include "atf.selectorLabels" (dict "ctx" $ctx "name" $c) | nindent 4 }}
{{- end -}}

{{/*
HorizontalPodAutoscaler (autoscaling/v2). Disabled by default; when enabled
the Deployment must not set replicas, which atf.deployment already honours.
*/}}
{{- define "atf.hpa" -}}
{{- $ctx := .ctx -}}
{{- $c := .name -}}
{{- if $ctx.Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "atf.fullname" (dict "ctx" $ctx "name" $c) }}
  labels:
    {{- include "atf.labels" (dict "ctx" $ctx "name" $c) | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "atf.fullname" (dict "ctx" $ctx "name" $c) }}
  minReplicas: {{ $ctx.Values.autoscaling.minReplicas }}
  maxReplicas: {{ $ctx.Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ $ctx.Values.autoscaling.targetCPUUtilizationPercentage }}
    {{- if $ctx.Values.autoscaling.targetMemoryUtilizationPercentage }}
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: {{ $ctx.Values.autoscaling.targetMemoryUtilizationPercentage }}
    {{- end }}
{{- end }}
{{- end -}}

{{/*
PodDisruptionBudget. Keeps a component available during voluntary
disruptions (node drains); requirement 12.3.
*/}}
{{- define "atf.pdb" -}}
{{- $ctx := .ctx -}}
{{- $c := .name -}}
{{- if $ctx.Values.podDisruptionBudget.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "atf.fullname" (dict "ctx" $ctx "name" $c) }}
  labels:
    {{- include "atf.labels" (dict "ctx" $ctx "name" $c) | nindent 4 }}
spec:
  {{- with $ctx.Values.podDisruptionBudget.minAvailable }}
  minAvailable: {{ . }}
  {{- end }}
  {{- with $ctx.Values.podDisruptionBudget.maxUnavailable }}
  maxUnavailable: {{ . }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "atf.selectorLabels" (dict "ctx" $ctx "name" $c) | nindent 6 }}
{{- end }}
{{- end -}}

{{/*
NetworkPolicy for one component: default-deny ingress, plus one allow rule
per client component listed in .clients (same namespace, same release).
The topology comes from design.md: control->runtime, runtime->gate/search,
search<->extract. Control is the user-facing edge and additionally accepts
ingress from anywhere when .publicIngress is true.

The Extract -> converter hop needs no policy: the converter (LibreOffice)
runs as a local subprocess inside the Extract pod, not as a network peer.
*/}}
{{- define "atf.networkPolicy" -}}
{{- $ctx := .ctx -}}
{{- $c := .name -}}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "atf.fullname" (dict "ctx" $ctx "name" $c) }}
  labels:
    {{- include "atf.labels" (dict "ctx" $ctx "name" $c) | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "atf.selectorLabels" (dict "ctx" $ctx "name" $c) | nindent 6 }}
  policyTypes:
    - Ingress
  {{- if or .publicIngress .clients }}
  ingress:
    {{- if .publicIngress }}
    - ports:
        - port: http
          protocol: TCP
    {{- end }}
    {{- range $client := .clients }}
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: {{ $ctx.Release.Namespace }}
          podSelector:
            matchLabels:
              {{- include "atf.selectorLabels" (dict "ctx" $ctx "name" $client) | nindent 14 }}
      ports:
        - port: http
          protocol: TCP
    {{- end }}
  {{- end }}
{{- end -}}

{{/*
One-shot schema migration Job as a Helm hook (pre-install,pre-upgrade),
requirement 12.3 / 12.4. Runs the standalone migrator of the service image
(`bun run scripts/migrate.ts`, see apps/<service>/scripts/migrate.ts) with
only the database URL from the service Secret — no model or auth config.
The replicas run with MIGRATE_ON_START=false (atf.defaultEnv), so the hook
is the single migration point; the migrators serialise on their advisory
lock even if a replica boots mid-migration.

Parameters (dict):
  ctx      subchart root context
  name     component name (runtime | search | extract)
  urlEnv   environment variable the migrator reads (DATABASE_URL | POSTGRES_URL | EXTRACT_DATABASE_URL)
  weight   hook weight, so several migration Jobs run in a defined order
*/}}
{{- define "atf.migrationJob" -}}
{{- $ctx := .ctx -}}
{{- $c := .name -}}
{{- if $ctx.Values.migration.enabled }}
{{- $secretName := index $ctx.Values.global.secrets $c | default "" }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ printf "%s-migrate-%s" (include "atf.fullname" (dict "ctx" $ctx "name" $c)) ($ctx.Release.Revision | toString) | trunc 63 | trimSuffix "-" }}
  labels:
    {{- include "atf.labels" (dict "ctx" $ctx "name" $c) | nindent 4 }}
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": {{ .weight | quote }}
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: {{ $ctx.Values.migration.backoffLimit }}
  activeDeadlineSeconds: {{ $ctx.Values.migration.activeDeadlineSeconds }}
  template:
    metadata:
      labels:
        {{- include "atf.selectorLabels" (dict "ctx" $ctx "name" $c) | nindent 8 }}
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        {{- include "atf.podSecurityContext" $ctx | nindent 8 }}
      {{- with $ctx.Values.global.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $ctx.Values.global.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $ctx.Values.global.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: migrate
          image: {{ include "atf.image" (dict "ctx" $ctx "repository" $ctx.Values.image.repository "digest" $ctx.Values.image.digest) | quote }}
          imagePullPolicy: {{ $ctx.Values.image.pullPolicy | default $ctx.Values.global.image.pullPolicy }}
          securityContext:
            {{- include "atf.containerSecurityContext" $ctx | nindent 12 }}
          command:
            - /usr/local/bin/bun
            - run
            - scripts/migrate.ts
          env:
            - name: {{ .urlEnv }}
              valueFrom:
                secretKeyRef:
                  name: {{ required (printf "%s.migration.enabled requires global.secrets.%s to name a Secret containing %s" $c $c .urlEnv) $secretName | quote }}
                  key: {{ .urlEnv | quote }}
            {{- with $ctx.Values.migration.extraEnv }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          volumeMounts:
            {{- include "atf.volumeMounts" $ctx | nindent 12 }}
      volumes:
        {{- include "atf.volumes" $ctx | nindent 8 }}
{{- end }}
{{- end -}}
