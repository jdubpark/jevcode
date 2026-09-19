import { useMemo } from "react";

import {
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import type { ArchitectureDeltaProps } from "@jevcode/contracts";

import { ActionButtons } from "./ActionButtons.js";
import {
  layoutArchitectureNodes,
  nodeKindClass,
} from "./architecture-layout.js";

const ARCH_NODE_WIDTH = 220;
const ARCH_NODE_HEIGHT = 64;

type ArchitectureFlowNodeData = {
  label: string;
  kind: ArchitectureDeltaProps["nodes"][number]["kind"];
  path?: string;
};

type ArchitectureFlowNode = Node<ArchitectureFlowNodeData, "architecture">;

const nodeTypes = {
  architecture: function ArchitectureNodeView({
    data,
  }: NodeProps<ArchitectureFlowNode>) {
    return (
      <div className="jevcode-arch-node-content">
        <Handle type="target" position={Position.Left} className="target" />
        <div className="jevcode-arch-node-label">{data.label}</div>
        {data.path !== undefined ? (
          <div className="jevcode-arch-node-path">{data.path}</div>
        ) : null}
        <Handle type="source" position={Position.Right} className="source" />
      </div>
    );
  },
};

export function ArchitectureDelta({ props }: { props: ArchitectureDeltaProps }) {
  const flow = useMemo(() => {
    const positioned = layoutArchitectureNodes(props.nodes, props.edges);
    const nodes: ArchitectureFlowNode[] = positioned.map((node) => ({
      id: node.id,
      type: "architecture",
      position: { x: node.x, y: node.y },
      width: ARCH_NODE_WIDTH,
      height: ARCH_NODE_HEIGHT,
      data: { label: node.label, kind: node.kind, path: node.path },
      className: `jevcode-arch-node ${nodeKindClass(node.kind)}`,
    }));
    const edges: Edge[] = props.edges.map((edge, index) => ({
      id: `e-${index}`,
      source: edge.from,
      target: edge.to,
      label: edge.label,
      ariaLabel: `edge ${edge.from} to ${edge.to}`,
    }));
    return { nodes, edges };
  }, [props.nodes, props.edges]);

  return (
    <div
      className="jevcode-architecture-delta"
      data-testid="architecture-delta"
    >
      <div className="jevcode-badges">
        <span className="jevcode-category" data-category={props.category}>
          {props.category}
        </span>
        <span className="jevcode-status" data-status={props.status}>
          {props.status}
        </span>
        {props.confidence !== undefined ? (
          <span
            className="jevcode-confidence"
            data-confidence={props.confidence}
          >
            {Math.round(props.confidence * 100)}%
          </span>
        ) : null}
        {props.scope !== undefined ? (
          <span className="jevcode-scope" data-scope={props.scope}>
            {props.scope}
          </span>
        ) : null}
      </div>
      <h3 className="jevcode-title">{props.title}</h3>
      {props.evidenceCount !== undefined ? (
        <div className="jevcode-arch-evidence" data-testid="arch-evidence">
          {props.evidenceCount} evidence facts
        </div>
      ) : null}
      <div
        className="jevcode-arch-graph"
        data-testid="arch-graph"
        data-node-count={flow.nodes.length}
        data-edge-count={flow.edges.length}
      >
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          fitView={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          panOnDrag={false}
          preventScrolling
          style={{ width: "100%", height: 420 }}
        />
      </div>
      {props.actions !== undefined && props.actions.length > 0 ? (
        <ActionButtons actions={props.actions} />
      ) : null}
    </div>
  );
}
