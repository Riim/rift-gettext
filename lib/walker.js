function walk(ast, opts) {
	visit(ast, null, opts.enter, opts.leave);
}

exports.walk = walk;

var context = {
	skip: function() {
		return context.shouldSkip = true;
	}
};

var nodePropertiesByType = {};

function visit(node, parent, enter, leave, prop, index) {
	if (!node) {
		return;
	}

	if (enter) {
		context.shouldSkip = false;

		enter.call(context, node, parent, prop, index);

		if (context.shouldSkip) {
			return;
		}
	}

	var nodeProperties = nodePropertiesByType[node.type] || (
		nodePropertiesByType[node.type] = Object.keys(node).filter(function(key) {
			return typeof node[key] == 'object';
		})
	);

	for (var i = nodeProperties.length; i;) {
		var childProperty = nodeProperties[--i];
		var value = node[childProperty];

		if (Array.isArray(value)) {
			for (var j = value.length; j;) {
				var val = value[--j];

				if (typeof val == 'object' && val.type) {
					visit(val, node, enter, leave, childProperty, j);
				}
			}
		} else if (value && value.type) {
			visit(value, node, enter, leave, childProperty, undefined);
		}
	}

	if (leave) {
		leave(node, parent, prop, index);
	}
}
