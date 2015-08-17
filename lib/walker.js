function walk(ast, opts) {
	visit(ast, null, opts.enter, opts.leave);
}

exports.walk = walk;

var context = {
	skip: function() {
		return context.shouldSkip = true;
	}
};

var childPropertiesByType = {};

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

	var childProperties = childPropertiesByType[node.type] || (
		childPropertiesByType[node.type] = Object.keys(node).filter(function(key) {
			return typeof node[key] == 'object';
		})
	);

	for (var i = childProperties.length; i;) {
		var childProperty = childProperties[--i];
		var value = node[childProperty];

		if (Array.isArray(value)) {
			for (var j = value.length; j;) {
				visit(value[--j], node, enter, leave, childProperty, j);
			}
		} else if (value && value.type) {
			visit(value, node, enter, leave, childProperty, null);
		}
	}

	if (leave) {
		leave(node, parent, prop, index);
	}
}
