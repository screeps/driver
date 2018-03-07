// Author: Marcel Laverdet <https://github.com/laverdet>
#include "pf.h"
#include <iostream>
#include <algorithm>
#include <stdexcept>

using namespace screeps;

	std::map<map_position_t, uint8_t*> path_finder_t::terrain;

	// path_finder_t ctor
	path_finder_t::path_finder_t() : depth(0), state(50 * 50 * k_max_rooms) {
	}

	// Return room index from a map position, allocates a new room index if needed and possible
	path_finder_t::room_index_t path_finder_t::room_index_from_pos(const map_position_t map_pos) {
		room_index_t room_index = state.reverse_room_table[map_pos.id];
		if (room_index == 0) {
			if (state.room_table.size() >= state.max_rooms) {
				return 0;
			}
			if (state.blocked_rooms.find(map_pos) != state.blocked_rooms.end()) {
				return 0;
			}
			std::map<map_position_t, uint8_t*>::iterator terrain_it = terrain.find(map_pos);
			if (terrain_it == terrain.end()) {
				Nan::ThrowError((std::string("Could not load terrain data")).c_str());
				throw js_error();
			}
			uint8_t* cost_matrix = NULL;
			if (!(*state.room_callback)->IsUndefined()) {
				Nan::TryCatch try_catch;
				v8::Local<v8::Value> argv[2];
				argv[0] = Nan::New(map_pos.xx);
				argv[1] = Nan::New(map_pos.yy);
				Nan::MaybeLocal<v8::Value> ret = Nan::Call(*state.room_callback, v8::Local<v8::Object>::Cast(Nan::Undefined()), 2, argv);
				if (try_catch.HasCaught()) {
					try_catch.ReThrow();
					throw js_error();
				}
				if (!ret.IsEmpty()) {
					v8::Local<v8::Value> ret_local = ret.ToLocalChecked();
					if (ret_local->IsBoolean() && ret_local->IsFalse()) {
						state.blocked_rooms.insert(map_pos);
						return 0;
					}
					state.room_data_handles[state.room_table.size()] = ret_local;
					Nan::TypedArrayContents<uint8_t> cost_matrix_js(state.room_data_handles[state.room_table.size()]);
					if (cost_matrix_js.length() == 2500) {
						cost_matrix = *cost_matrix_js;
					}
				}
			}
			state.room_table.push_back(room_info_t(terrain_it->second, cost_matrix, map_pos));
			return state.reverse_room_table[map_pos.id] = state.room_table.size();
		}
		return room_index;
	}

	// Conversions to/from index & world_position_t
	path_finder_t::pos_index_t path_finder_t::index_from_pos(const world_position_t pos) {
		room_index_t room_index = room_index_from_pos(pos.map_position());
		if (room_index == 0) {
			throw std::runtime_error("Invalid invocation of index_from_pos");
		}
		return pos_index_t(room_index - 1) * 50 * 50 + pos.xx % 50 * 50 + pos.yy % 50;
	}

	world_position_t path_finder_t::pos_from_index(path_finder_t::pos_index_t index) const {
		room_index_t room_index = index / (50 * 50);
		const room_info_t& terrain = state.room_table[room_index];
		uint16_t coord = index - room_index * 50 * 50;
		return world_position_t(coord / 50 + terrain.pos.xx * 50, coord % 50 + terrain.pos.yy * 50);
	}

	// Push a new node to the heap, or update its cost if it already exists
	void path_finder_t::push_node(path_finder_t::pos_index_t parent_index, world_position_t node, cost_t g_cost) {
		pos_index_t index = index_from_pos(node);
		if (state.open_closed.is_closed(index)) {
			return;
		}
		cost_t h_cost = heuristic(node) * state.heuristic_weight;
		cost_t f_cost = h_cost + g_cost;

		if (state.open_closed.is_open(index)) {
			if (state.heap.priority(index) > f_cost) {
				state.heap.update(index, f_cost);
				state.parents[index] = parent_index;
				// std::cout <<"~ " <<node <<": h(" <<h_cost <<") + " <<"g(" <<g_cost <<") = f(" <<f_cost <<")\n";
			}
		} else {
			state.heap.push(index, f_cost);
			state.open_closed.open(index);
			state.parents[index] = parent_index;
			// std::cout <<"+ " <<node <<": h(" <<h_cost <<") + " <<"g(" <<g_cost <<") = f(" <<f_cost <<")\n";
		}
	}

	// Return cost of moving to a node
	path_finder_t::cost_t path_finder_t::look(const world_position_t pos) {
		room_index_t room_index = room_index_from_pos(pos.map_position());
		if (room_index == 0) {
			return obstacle;
		}
		const room_info_t& terrain = state.room_table[room_index - 1];
		if (terrain.cost_matrix != NULL) {
			uint8_t tmp = terrain.cost_matrix[pos.xx % 50][pos.yy % 50];
			if (tmp != 0) {
				if (tmp == 0xff) {
					return obstacle;
				} else {
					return tmp;
				}
			}
		}
		uint8_t tile = terrain.look(pos.xx % 50, pos.yy % 50);
		switch (tile) {
			case 0: // PLAIN
				return state.plain_cost;
			case 1: // WALL
			case 3: // WALL + SWAMP (lol)
				return obstacle;
			case 2: // SWAMP
				return state.swamp_cost;
		}
		return 1;
	}

	// Returns the minimum Chebyshev distance to a goal
	path_finder_t::cost_t path_finder_t::heuristic(const world_position_t pos) const {
		if (state.flee) {
			cost_t ret = 0;
			for (size_t ii = 0; ii < state.goals.size(); ++ii) {
				cost_t dist = pos.range_to(state.goals[ii].pos);
				if (dist < state.goals[ii].range) {
					ret = std::max<cost_t>(ret, state.goals[ii].range - dist);
				}
			}
			return ret;
		} else {
			cost_t ret = std::numeric_limits<cost_t>::max();
			for (size_t ii = 0; ii < state.goals.size(); ++ii) {
				cost_t dist = pos.range_to(state.goals[ii].pos);
				if (dist > state.goals[ii].range) {
					ret = std::min<cost_t>(ret, dist - state.goals[ii].range);
				} else {
					ret = 0;
				}
			}
			return ret;
		}
	}

	// Run an iteration of basic A*
	void path_finder_t::astar(path_finder_t::pos_index_t index, world_position_t pos, path_finder_t::cost_t g_cost) {
		for (int dir = world_position_t::TOP; dir <= world_position_t::TOP_LEFT; ++dir) {
			world_position_t neighbor = pos.position_in_direction(static_cast<world_position_t::direction_t>(dir));

			// If this is a portal node there are some moves which will be impossible, and should be discarded
			if (pos.xx % 50 == 0) {
				if (neighbor.xx % 50 == 49 && pos.yy != neighbor.yy) {
					continue;
				} else if (pos.xx == neighbor.xx) {
					continue;
				}
			} else if (pos.xx % 50 == 49) {
				if (neighbor.xx % 50 == 0 && pos.yy != neighbor.yy) {
					continue;
				} else if (pos.xx == neighbor.xx) {
					continue;
				}
			} else if (pos.yy % 50 == 0) {
				if (neighbor.yy % 50 == 49 && pos.xx != neighbor.xx) {
					continue;
				} else if (pos.yy == neighbor.yy) {
					continue;
				}
			} else if (pos.yy % 50 == 49) {
				if (neighbor.yy % 50 == 0 && pos.xx != neighbor.xx) {
					continue;
				} else if (pos.yy == neighbor.yy) {
					continue;
				}
			}

			// Calculate cost of this move
			cost_t n_cost = look(neighbor);
			if (n_cost == obstacle) {
				// std::cout <<"# " <<neighbor <<"\n";
				continue;
			}
			push_node(index, neighbor, g_cost + n_cost);
		}
	}

	// JPS dragons
	world_position_t path_finder_t::jump_x(path_finder_t::cost_t cost, world_position_t pos, int8_t dx) {
		cost_t prev_cost_u = look(world_position_t(pos.xx, pos.yy - 1));
		cost_t prev_cost_d = look(world_position_t(pos.xx, pos.yy + 1));
		while (true) {
			if (
				heuristic(pos) == 0 ||
				(pos.xx + 2) % 50 < 4
			) {
				return pos;
			}

			cost_t cost_u = look(world_position_t(pos.xx + dx, pos.yy - 1));
			cost_t cost_d = look(world_position_t(pos.xx + dx, pos.yy + 1));
			if (
				(cost_u != obstacle && prev_cost_u != cost) ||
				(cost_d != obstacle && prev_cost_d != cost)
			) {
				return pos;
			}
			prev_cost_u = cost_u;
			prev_cost_d = cost_d;
			pos.xx += dx;

			cost_t jump_cost = look(pos);
			if (jump_cost == obstacle) {
				return world_position_t::null();
			} else if (jump_cost != cost) {
				return pos;
			}
		}
	}

	world_position_t path_finder_t::jump_y(path_finder_t::cost_t cost, world_position_t pos, int8_t dy) {
		cost_t prev_cost_l = look(world_position_t(pos.xx - 1, pos.yy));
		cost_t prev_cost_r = look(world_position_t(pos.xx + 1, pos.yy));
		while (true) {
			if (
				heuristic(pos) == 0 ||
				(pos.yy + 2) % 50 < 4
			) {
				return pos;
			}

			cost_t cost_l = look(world_position_t(pos.xx - 1, pos.yy + dy));
			cost_t cost_r = look(world_position_t(pos.xx + 1, pos.yy + dy));
			if (
				(cost_l != obstacle && prev_cost_l != cost) ||
				(cost_r != obstacle && prev_cost_r != cost)
			) {
				return pos;
			}
			prev_cost_l = cost_l;
			prev_cost_r = cost_r;
			pos.yy += dy;

			cost_t jump_cost = look(pos);
			if (jump_cost == obstacle) {
				return world_position_t::null();
			} else if (jump_cost != cost) {
				return pos;
			}
		}
	}

	world_position_t path_finder_t::jump_xy(path_finder_t::cost_t cost, world_position_t pos, int8_t dx, int8_t dy) {
		cost_t prev_cost_x = look(world_position_t(pos.xx - dx, pos.yy));
		cost_t prev_cost_y = look(world_position_t(pos.xx, pos.yy - dy));
		while (true) {
			if (
				heuristic(pos) == 0 ||
				(pos.xx + 2) % 50 < 4 ||
				(pos.yy + 2) % 50 < 4
			) {
				return pos;
			}

			if (
				(look(world_position_t(pos.xx - dx, pos.yy + dy)) != obstacle && prev_cost_x != cost) ||
				(look(world_position_t(pos.xx + dx, pos.yy - dy)) != obstacle && prev_cost_y != cost)
			) {
				return pos;
			}
			prev_cost_x = look(world_position_t(pos.xx, pos.yy + dy));
			prev_cost_y = look(world_position_t(pos.xx + dx, pos.yy));
			if (
				(prev_cost_y != obstacle && !jump_x(cost, world_position_t(pos.xx + dx, pos.yy), dx).is_null()) ||
				(prev_cost_x != obstacle && !jump_y(cost, world_position_t(pos.xx, pos.yy + dy), dy).is_null())
			) {
				return pos;
			}

			pos.xx += dx;
			pos.yy += dy;

			cost_t jump_cost = look(pos);
			if (jump_cost == obstacle) {
				return world_position_t::null();
			} else if (jump_cost != cost) {
				return pos;
			}
		}
	}

	world_position_t path_finder_t::jump(path_finder_t::cost_t cost, world_position_t pos, int8_t dx, int8_t dy) {
		if (dx != 0) {
			if (dy != 0) {
				return jump_xy(cost, pos, dx, dy);
			} else {
				return jump_x(cost, pos, dx);
			}
		} else {
			return jump_y(cost, pos, dy);
		}
	}

	void path_finder_t::jps(pos_index_t index, world_position_t pos, path_finder_t::cost_t g_cost) {
		world_position_t parent = pos_from_index(state.parents[index]);
		int8_t dx = pos.xx > parent.xx ? 1 : (pos.xx < parent.xx ? -1 : 0);
		int8_t dy = pos.yy > parent.yy ? 1 : (pos.yy < parent.yy ? -1 : 0);

		// First check to see if we're jumping to/from a border, options are limited in this case
		world_position_t neighbors[3];
		uint8_t neighbor_count = 0;
		if (pos.xx % 50 == 0) {
			if (dx == -1) {
				neighbors[0] = world_position_t(pos.xx - 1, pos.yy);
				neighbor_count = 1;
			} else if (dx == 1) {
				neighbors[0] = world_position_t(pos.xx + 1, pos.yy - 1);
				neighbors[1] = world_position_t(pos.xx + 1, pos.yy);
				neighbors[2] = world_position_t(pos.xx + 1, pos.yy + 1);
				neighbor_count = 3;
			}
		} else if (pos.xx % 50 == 49) {
			if (dx == 1) {
				neighbors[0] = world_position_t(pos.xx + 1, pos.yy);
				neighbor_count = 1;
			} else if (dx == -1) {
				neighbors[0] = world_position_t(pos.xx - 1, pos.yy - 1);
				neighbors[1] = world_position_t(pos.xx - 1, pos.yy);
				neighbors[2] = world_position_t(pos.xx - 1, pos.yy + 1);
				neighbor_count = 3;
			}
		} else if (pos.yy % 50 == 0) {
			if (dy == -1) {
				neighbors[0] = world_position_t(pos.xx, pos.yy - 1);
				neighbor_count = 1;
			} else if (dy == 1) {
				neighbors[0] = world_position_t(pos.xx - 1, pos.yy + 1);
				neighbors[1] = world_position_t(pos.xx, pos.yy + 1);
				neighbors[2] = world_position_t(pos.xx + 1, pos.yy + 1);
				neighbor_count = 3;
			}
		} else if (pos.yy % 50 == 49) {
			if (dy == 1) {
				neighbors[0] = world_position_t(pos.xx, pos.yy + 1);
				neighbor_count = 1;
			} else if (dy == -1) {
				neighbors[0] = world_position_t(pos.xx - 1, pos.yy - 1);
				neighbors[1] = world_position_t(pos.xx, pos.yy - 1);
				neighbors[2] = world_position_t(pos.xx + 1, pos.yy - 1);
				neighbor_count = 3;
			}
		}

		// Add special nodes from the above blocks to the heap
		if (neighbor_count != 0) {
			for (uint8_t ii = 0; ii < neighbor_count; ++ii) {
				cost_t n_cost = look(neighbors[ii]);
				if (n_cost == obstacle) {
					continue;
				}
				push_node(index, neighbors[ii], g_cost + n_cost);
			}
			return;
		}

		// Regular JPS iteration follows

		// First check to see if we're close to borders
		int8_t border_dx = 0;
		if (pos.xx % 50 == 1) {
			border_dx = -1;
		} else if (pos.xx % 50 == 48) {
			border_dx = 1;
		}
		int8_t border_dy = 0;
		if (pos.yy % 50 == 1) {
			border_dy = -1;
		} else if (pos.yy % 50 == 48) {
			border_dy = 1;
		}

		// Now execute the logic that is shared between diagonal and straight jumps
		cost_t cost = look(pos);
		if (dx != 0) {
			world_position_t neighbor = world_position_t(pos.xx + dx, pos.yy);
			cost_t n_cost = look(neighbor);
			if (n_cost != obstacle) {
				if (border_dy == 0) {
					jump_neighbor(pos, index, neighbor, g_cost, cost, n_cost);
				} else {
					push_node(index, neighbor, g_cost + n_cost);
				}
			}
		}
		if (dy != 0) {
			world_position_t neighbor = world_position_t(pos.xx, pos.yy + dy);
			cost_t n_cost = look(neighbor);
			if (n_cost != obstacle) {
				if (border_dx == 0) {
					jump_neighbor(pos, index, neighbor, g_cost, cost, n_cost);
				} else {
					push_node(index, neighbor, g_cost + n_cost);
				}
			}
		}

		// Forced neighbor rules
		if (dx != 0) {
			if (dy != 0) { // Jumping diagonally
				world_position_t neighbor = world_position_t(pos.xx + dx, pos.yy + dy);
				cost_t n_cost = look(neighbor);
				if (n_cost != obstacle) {
					jump_neighbor(pos, index, neighbor, g_cost, cost, n_cost);
				}
				if (look(world_position_t(pos.xx - dx, pos.yy)) != cost) {
					jump_neighbor(pos, index, world_position_t(pos.xx - dx, pos.yy + dy), g_cost, cost, look(world_position_t(pos.xx - dx, pos.yy + dy)));
				}
				if (look(world_position_t(pos.xx, pos.yy - dy)) != cost) {
					jump_neighbor(pos, index, world_position_t(pos.xx + dx, pos.yy - dy), g_cost, cost, look(world_position_t(pos.xx + dx, pos.yy - dy)));
				}
			} else { // Jumping left / right
				if (border_dy == 1 || look(world_position_t(pos.xx, pos.yy + 1)) != cost) {
					jump_neighbor(pos, index, world_position_t(pos.xx + dx, pos.yy + 1), g_cost, cost, look(world_position_t(pos.xx + dx, pos.yy + 1)));
				}
				if (border_dy == -1 || look(world_position_t(pos.xx, pos.yy - 1)) != cost) {
					jump_neighbor(pos, index, world_position_t(pos.xx + dx, pos.yy - 1), g_cost, cost, look(world_position_t(pos.xx + dx, pos.yy - 1)));
				}
			}
		} else { // Jumping up / down
			if (border_dx == 1 || look(world_position_t(pos.xx + 1, pos.yy)) != cost) {
				jump_neighbor(pos, index, world_position_t(pos.xx + 1, pos.yy + dy), g_cost, cost, look(world_position_t(pos.xx + 1, pos.yy + dy)));
			}
			if (border_dx == -1 || look(world_position_t(pos.xx - 1, pos.yy)) != cost) {
				jump_neighbor(pos, index, world_position_t(pos.xx - 1, pos.yy + dy), g_cost, cost, look(world_position_t(pos.xx - 1, pos.yy + dy)));
			}
		}
	}

	void path_finder_t::jump_neighbor(world_position_t pos, path_finder_t::pos_index_t index, world_position_t neighbor, path_finder_t::cost_t g_cost, path_finder_t::cost_t cost, path_finder_t::cost_t n_cost) {
		if (
			n_cost != cost ||
			neighbor.xx % 50 == 0 || neighbor.xx % 50 == 49 ||
			neighbor.yy % 50 == 0 || neighbor.yy % 50 == 49
		) {
			if (n_cost == obstacle) {
				return;
			}
			g_cost += n_cost;
		} else {
			neighbor = jump(n_cost, neighbor, neighbor.xx - pos.xx, neighbor.yy - pos.yy);
			if (neighbor.is_null()) {
				return;
			}
			g_cost += n_cost * (pos.range_to(neighbor) - 1) + look(neighbor);
		}

		push_node(index, neighbor, g_cost);
	}

	v8::Local<v8::Value> path_finder_t::search(
		v8::Local<v8::Value> origin_js,
		v8::Local<v8::Array> goals_js,
		v8::Local<v8::Function> room_callback,
		path_finder_t::cost_t plain_cost,
		path_finder_t::cost_t swamp_cost,
		uint8_t max_rooms,
		uint32_t max_ops,
		uint32_t max_cost,
		bool flee,
		double heuristic_weight
	) {

		// Clean up from previous iteration
		state_manager_t state_manager(*this);
		for (size_t ii = 0; ii < state.room_table.size(); ++ii) {
			state.reverse_room_table[state.room_table[ii].pos.id] = 0;
		}
		state.room_table.clear();
		state.blocked_rooms.clear();
		state.goals.clear();
		state.open_closed.clear();
		state.heap.clear();

		// Construct goal objects
		for (uint32_t ii = 0; ii < goals_js->Length(); ++ii) {
			state.goals.push_back(goal_t(Nan::Get(goals_js, ii).ToLocalChecked()));
		}

		// These aren't ever accessed, this is just a place to put the handles for the CostMatrix data
		// so it doesn't get gc'd
		v8::Local<v8::Value> room_data_handles[k_max_rooms];
		state.room_data_handles = room_data_handles;
		state.room_callback = &room_callback;

		// Other initialization
		state.plain_cost = plain_cost;
		state.swamp_cost = swamp_cost;
		state.max_rooms = max_rooms;
		state.heuristic_weight = heuristic_weight;
		uint32_t ops_remaining = max_ops;
		state.flee = flee;
		world_position_t origin(origin_js);
		cost_t min_node_h_cost = std::numeric_limits<cost_t>::max();
		cost_t min_node_g_cost = std::numeric_limits<cost_t>::max();
		pos_index_t min_node = 0;

		// Special case for searching to same node, otherwise it searches everywhere because origin node
		// is closed
		if (heuristic(origin) == 0) {
			return Nan::Undefined();
		}

		try {
			// Prime data for `index_from_pos`
			if (room_index_from_pos(origin.map_position()) == 0) {
				// Initial room is inaccessible
				return Nan::New(-1);
			}

			// Initial A* iteration
			min_node = index_from_pos(origin);
			astar(min_node, origin, 0);

			// Loop until we have a solution
			while (state.heap.size() && ops_remaining > 0) {

				// Pull cheapest open node off the (c)heap
				pos_index_t index = state.heap.min();
				cost_t f_cost = state.heap.min_priority();

				// Close this node
				state.heap.pop();
				state.open_closed.close(index);

				// Calculate costs
				world_position_t pos = pos_from_index(index);
				cost_t h_cost = heuristic(pos);
				cost_t g_cost = f_cost - cost_t(h_cost * state.heuristic_weight);
				// std::cout <<"\n* " <<pos <<": h(" << h_cost <<") + " <<"g(" <<g_cost <<") = f(" <<f_cost <<")\n";

				// Reached destination?
				if (h_cost == 0) {
					min_node = index;
					min_node_h_cost = 0;
					min_node_g_cost = g_cost;
					break;
				} else if (h_cost < min_node_h_cost) {
					min_node = index;
					min_node_h_cost = h_cost;
					min_node_g_cost = g_cost;
				}
				if (g_cost + h_cost > max_cost) {
					break;
				}

				// Add next neighbors to heap
				jps(index, pos, g_cost);
				--ops_remaining;

				// Check termination
				if (v8::Isolate::GetCurrent()->IsExecutionTerminating()) {
					return Nan::Undefined();
				}
			}
		} catch (js_error) {
			// Whoever threw the `js_error` should set the exception for v8
			return Nan::Undefined();
		}

		// Reconstruct path from A* graph
		v8::Local<v8::Array> path = Nan::New<v8::Array>(0);
		pos_index_t index = min_node;
		world_position_t pos = pos_from_index(index);
		uint32_t ii = 0;
		while (pos != origin) {
			v8::Local<v8::Array> tmp = Nan::New<v8::Array>(2);
			Nan::Set(tmp, 0, Nan::New(pos.xx));
			Nan::Set(tmp, 1, Nan::New(pos.yy));
			Nan::Set(path, ii, tmp);
			++ii;
			index = state.parents[index];
			world_position_t next = pos_from_index(index);
			if (next.range_to(pos) > 1) {
				world_position_t::direction_t dir = pos.direction_to(next);
				do {
					pos = pos.position_in_direction(dir);
					v8::Local<v8::Array> tmp = Nan::New<v8::Array>(2);
					Nan::Set(tmp, 0, Nan::New(pos.xx));
					Nan::Set(tmp, 1, Nan::New(pos.yy));
					Nan::Set(path, ii, tmp);
					++ii;
				} while (pos.range_to(next) > 1);
			}
			pos = next;
		}
		v8::Local<v8::Object> ret = Nan::New<v8::Object>();
		Nan::Set(ret, Nan::New("path").ToLocalChecked(), path);
		Nan::Set(ret, Nan::New("ops").ToLocalChecked(), Nan::New(max_ops - ops_remaining));
		Nan::Set(ret, Nan::New("cost").ToLocalChecked(), Nan::New(min_node_g_cost));
		Nan::Set(ret, Nan::New("incomplete").ToLocalChecked(), Nan::New<v8::Boolean>(min_node_h_cost != 0));
		return ret;
	}

	// Loads static terrain data into module upfront
	void path_finder_t::load_terrain(v8::Local<v8::Array> terrain) {
		uint8_t* data = new uint8_t[terrain->Length() * 625];
		for (uint32_t ii = 0; ii < terrain->Length(); ++ii) {
			v8::Local<v8::Object> terrain_info = Nan::To<v8::Object>(Nan::Get(terrain, ii).ToLocalChecked()).ToLocalChecked();
			map_position_t pos = Nan::Get(terrain_info, Nan::New("room").ToLocalChecked()).ToLocalChecked();
			memcpy(data + ii * 625, *Nan::TypedArrayContents<uint8_t>(Nan::Get(terrain_info, Nan::New("bits").ToLocalChecked()).ToLocalChecked()), 625);
			path_finder_t::terrain.insert(std::make_pair(pos, data + ii * 625));
		}
	}
