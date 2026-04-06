/*
 * ========================================================================
 *
 * Copyright (c) 2021 MICRO FOCUS OR ONE OF ITS AFFILIATES.
 *  THE ONLY WARRANTIES FOR PRODUCTS AND SERVICES OF MICRO FOCUS AND ITS AFFILIATES AND LICENSORS (MICRO FOCUS) ARE SET
 *  FORTH IN THE EXPRESS WARRANTY STATEMENTS ACCOMPANYING SUCH PRODUCTS AND SERVICES. NOTHING HEREIN SHOULD BE CONSTRUED
 *  AS CONSTITUTING AN ADDITIONAL WARRANTY. MICRO FOCUS SHALL NOT BE LIABLE FOR TECHNICAL OR EDITORIAL ERRORS OR OMISSIONS CONTAINED HEREIN.
 *  THE INFORMATION CONTAINED HEREIN IS SUBJECT TO CHANGE WITHOUT NOTICE.
 *  CONTAINS CONFIDENTIAL INFORMATION. EXCEPT AS SPECIFICALLY INDICATED OTHERWISE,
 *  A VALID LICENSE IS REQUIRED FOR POSSESSION, USE OR COPYING. CONSISTENT WITH FAR 12.211 AND 12.212,
 *  COMMERCIAL COMPUTER SOFTWARE, COMPUTER SOFTWARE DOCUMENTATION, AND TECHNICAL DATA FOR COMMERCIAL ITEMS
 *  ARE LICENSED TO THE U.S. GOVERNMENT UNDER VENDOR'S STANDARD COMMERCIAL LICENSE.
 *
 * ========================================================================
 */

export const iam = {
  "name": "WFBuilderExtension",
  "prefix": "iam",
  "uri": "http://some-company/schema/bpmn/a",
  "xml": {
    "tagAlias": "lowerCase"
  },
  "types": [
    {
      "name": "Start-activity",
      "superClass": [
        "bpmn:StartEvent"
      ],
      "properties": [
        {
          "name": "form-id",
          "isAttr": true,
          "type": "String",
          "required": true
        },
        {
          "name": "activity-id",
          "isAttr": true,
          "type": "String",
        },
        {
          "name": "resource-name-override",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "resource-name-override-type",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "digital-signature-type",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Ig-catalog-request-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "requester",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "reason",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "requestSource",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "request-items",
          "isAttr": true,
          "type": "Object"
        },

      ]
    },
    {
      "name": "Log-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "author",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "audit",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "message",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "comment",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "User-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "form-id",
          "isAttr": true,
          "type": "String",
          "required": true
        },
        {
          "name": "addressee",
          "isAttr": true,
          "type": "String",
        },
        {
          "name": "reminder-start",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "reminder-interval",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-addressee",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-count",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-interval",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-reminder-start",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-reminder-interval",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "ontimeout",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "timeout",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "timeout-units",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "exclude-request-principals",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "quorumType",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "approver-type",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "approver-condition-expr",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "approver-condition",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "setnotify",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "digital-signature-type",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "priority",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Condition-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "expression",
          "isAttr": true,
          "type": "String",
          "required": true
        },
        {
          "name": "safe-looping",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Mapping-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "activity-name",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "workflowstatus",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Addressee-values",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "Addresseevalues",
          "isMany": true,
          "type": "Addressee-value"
        }
      ]
    },
    {
      "name": "Addressee-value",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "id",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "addressee",
          "isAttr": false,
          "type": "String"
        },]
    },
    {
      "name": "Request-items",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "Requestitems",
          "isMany": true,
          "type": "Request-item"
        }
      ]
    },
    {
      "name": "Request-item",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "id",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "reason",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "originalItemDisplayName",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "recipientDisplayName",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "originalRequestItem",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "recipient",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "displayName",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "requestItem",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "instanceGuid",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "type",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "igRequestParams",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "requestItemType",
          "isAttr": false,
          "type": "String"
        }
      ]
    },
    {
      "name": "ServerSearchCriteria",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "ServerCriteriaPerms",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "SearchCriteria",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "IncludeUsers",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "Roles",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "Perms",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "MembCrits",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "ExcludedGroups",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "ExcludedUsers",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "IncludedGroups",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "SodProperties"
        }
      ]
    },
    {
      "name": "SodProperties",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "id",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "displayName",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "description",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "uniqueId",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "appId",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "normalId",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "startDate",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "endDate",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "autoRequest",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "criterias",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "perms",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "attributeValue",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "attributeMatch",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "attributeValues",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "attributeKey",
          "isAttr": false,
          "type": "String"
        },
      ]
    },
    {
      "name": "Http-headers",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "HttpHeaders",
          "isMany": true,
          "type": "Http-header"
        }
      ]
    },
    {
      "name": "Http-header",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "id",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "key",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "value",
          "isAttr": false,
          "type": "String"
        }
      ]
    },
    {
      "name": "Rest-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "method",
          "isAttr": true,
          "type": "String",
          "required": true
        },
        {
          "name": "apiUrl",
          "isAttr": true,
          "type": "String",
          "required": true
        },
        {
          "name": "timeout",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "trustManagers",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "acceptHeader",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "contentTypeHeader",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "content",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "authType",
          "isAttr": true,
          "type": "String",
          "required": true
        },
        {
          "name": "grantType",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "clientId",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "oauthIssuerUrl",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "clientSecret",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "authUname",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "authPassword",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "resUname",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "resPassword",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "returnStatusCodeOutputMap",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "returnContentTypeOutputMap",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "returnContentOutputMap",
          "isAttr": false,
          "type": "String"
        }
      ]
    },
    {
      "name": "Finish-activity",
      "superClass": [
        "bpmn:EndEvent"
      ],
      "properties": [
        {
          "name": "setnotify",
          "isAttr": true,
          "type": "String"
        },
      ]
    },
    {
      "name": "Notification-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "setnotify",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Notify-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "channel",
          "isAttr": true,
          "type": "String"
        }, {
          "name": "notifyType",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Redirect-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "url",
          "isAttr": true,
          "type": "String",
          "required": false
        }, {
          "name": "serviceRegistry",
          "isAttr": true,
          "type": "String",
        }, {
          "name": "serviceAccountId",
          "isAttr": true,
          "type": "String",
        },
        {
          "name": "serviceAccountSecret",
          "isAttr": true,
          "type": "String",
        },
        {
          "name": "form-id",
          "isAttr": true,
          "type": "String",
          "required": true
        },
        {
          "name": "addressee",
          "isAttr": true,
          "type": "String",
        },
        {
          "name": "reminder-start",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "reminder-interval",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-addressee",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-count",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-interval",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-reminder-start",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "retry-reminder-interval",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "ontimeout",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "timeout",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "timeout-units",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "exclude-request-principals",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "quorumType",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "approver-type",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "approver-condition-expr",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "approver-condition",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "setnotify",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "digital-signature-type",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "priority",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Branch-activity",
      "superClass": [
        "bpmn:StartEvent"
      ],
      "properties": [
      ]
    },
    {
      "name": "Merge-activity",
      "superClass": [
        "bpmn:EndEvent"
      ],
      "properties": [
        {
          "name": "branch-activity-id",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Entity-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "display-name",
          "isAttr": true,
          "type": "String"
        }, {
          "name": "entity-type",
          "isAttr": true,
          "type": "String"
        }, {
          "name": "operation",
          "isAttr": true,
          "type": "String"
        }, {
          "name": "set-completed-approval-status",
          "isAttr": true,
          "type": "String"
        }, {
          "name": "deleteobject",
          "isAttr": true,
          "type": "Boolean"
        }
      ]
    },
    {
      "name": "Integration-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "wsdl-resource",
          "isAttr": true,
          "type": "String",
          "required": true
        }, {
          "name": "timeout",
          "isAttr": true,
          "type": "String"
        }, {
          "name": "retry",
          "isAttr": true,
          "type": "String"
        }, {
          "name": "ontimeout",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "portType",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "operation",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "endPoint",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "userId",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "password",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "useWsdlGenerationType",
          "isAttr": true,
          "type": "Boolean"
        },
        {
          "name": "inputMethodName",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "outputMethodName",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "targetNameSpaceURL",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Ig-sod-activity",
      "superClass": [
        "bpmn:Gateway"
      ],
      "properties": [
        {
          "name": "indexFrom",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "size",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "sortBy",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "sortOrder",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "includedUsers",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "searchQuery",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "returnStatusCodeOutputMap",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "returnContentTypeOutputMap",
          "isAttr": false,
          "type": "String"
        },
        {
          "name": "returnContentOutputMap",
          "isAttr": false,
          "type": "String"
        }
      ]
    },
    {
      "name": "Forms",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "Element"
        }
      ]
    },
    {
      "name": "returnStatusCodeOutputMap",
      "superClass": [
        "Element"
      ]
    },
    {
      "name": "Data-items",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "Data-item"
        }
      ]
    },
    {
      "name": "Data-item",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "data-type",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "name",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "source",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "target",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "target-type",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "multiValued",
          "isAttr": true,
          "type": "Boolean"
        },
        {
          "name": "modifyType",
          "isAttr": true,
          "type": "list"
        },
        {
          "name": "displayLabel",
          "isAttr": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Map",
      "superClass": [
        "Element"
      ],
      "properties": [

        {
          "name": "value",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "key",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "name",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "data-type",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "source",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "target",
          "isAttr": true,
          "type": "String"
        },
      ]
    },
    {
      "name": "Notify",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "Map"
        },
        {
          "name": "template",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "templateId",
          "isAttr": true,
          "type": "String"
        },
      ]
    },
    {
      "name": "Retry",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "Map"
        },
        {
          "name": "template",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "templateId",
          "isAttr": true,
          "type": "String"
        },
      ]
    },
    {
      "name": "Reminder",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "dataField",
          "isMany": true,
          "type": "Map"
        },
        {
          "name": "template",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "templateId",
          "isAttr": true,
          "type": "String"
        },
      ]
    },
    {
      "name": "Display-name",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "xml-lang",
          "isAttr": true,
          "type": "String"
        },
        {
          "name": "text",
          "isBody": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Expression",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "text",
          "isBody": true,
          "type": "String"
        }
      ]
    },
    {
      "name": "Fault-maps",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "faultMapValues",
          "isMany": true,
          "type": "Map"
        }
      ]
    },
    {
      "name": "Input-maps",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "inputMapValues",
          "isMany": true,
          "type": "Map"
        }
      ]
    },
    {
      "name": "Output-maps",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "outputMapValues",
          "isMany": true,
          "type": "Map"
        }
      ]
    },
    {
      "name": "Project",
      "superClass": [
        "Element"
      ],
      "properties": [
        {
          "name": "inputEnvelopeJson",
          "type": "String"
        },
        {
          "name": "outputEnvelopeJson",
          "type": "String"
        }
      ]
    }
  ],
  "emumerations": [],
  "associations": []
}