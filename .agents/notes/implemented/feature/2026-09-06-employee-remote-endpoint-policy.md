# Agent Note: Deployment-owned Remote endpoint permissions

Status: implemented

English | [中文](2026-09-06-employee-remote-endpoint-policy.zh.md)

## Problem

An employee conversation runtime can expose Host settings, preset selection, or workspace operations even when its model tools allow only business reads. Hiding browser controls does not remove HTTP calls, and restricting HTTP paths alone does not restrict logical streams carried by one WebSocket.

## Decision

[Gateway](../../../../packages/api/gateway/README.md) accepts a deployment-owned `allowedEndpoints` list. Its default `all` preserves unrestricted Host dispatch; an explicit empty list denies all endpoints. Names are exact and schema-validated. The Gateway copies the list at construction, outside request arguments and mutable caller arrays.

The dispatcher checks permission before descriptor, Context, and lookup resolution for both unary and stream calls. Reserved event transport endpoints are independently checked. A denied call returns `gateway/forbidden` without executing its business method. Strict generated descriptors and SRC markers share this enforcement.

## Alternatives considered

**Hide controls or remove model schemas.** A caller can send the underlying RPC directly; presentation is not an execution permission.

**Filter only reverse-proxy paths.** Multiple logical streams share one WebSocket path, and local transports can call the same dispatcher without HTTP.

**Make this a multi-user authorization service.** Endpoint permission has no employee identity or document ownership context. Those responsibilities stay with isolated deployment and business owners rather than an endpoint-name check.

## Consequences

The policy gives a dedicated employee Host a deny-by-default RPC list while leaving ordinary profiles unchanged. It does not sandbox the process, protect unrelated routes, or make a shared Host multi-tenant. An allowed method can still dispatch arbitrary actions through its own arguments, so employee compositions must review command, preset, workspace, file, and plugin APIs rather than allow whole namespaces.

Allowing `$events` exposes the full configured event selection; it is not per-employee filtering. Active streams retain their opening permission until cancellation or Gateway disposal. Replacing or revoking employee access requires lifecycle control outside this immutable list.

## Verification

The package-owned Loader fixture exercises actual Connection HTTP and Gateway WebSocket dispatch, direct calls, strict and SRC definitions, reserved endpoints, browser authentication, and Gateway disposal. Files outside the dispatcher verify that rejected writes have no effect. Two concurrently loaded Hosts hold separate credential owners and fixture files; this is not a production employee-session or operating-system isolation test.

The denial regression fails against the unmodified dispatcher because the forbidden method executes. Restoring the policy makes the focused suite pass. No model prompt, tool schema, or session event changes; transport expectations belong to the package tests rather than a recorded model transcript.
