// Author: Marcel Laverdet <https://github.com/laverdet>
#include <nan.h>
#include <iostream>
#include <memory>
#include <vector>
#include <map>
#include <set>
#include <stdexcept>

namespace screeps {

	const unsigned int k_max_rooms = 16;

	//
	// Stores coordinates of a room on the global world map.
	// For instance, "E1N1" -> { xx: 129, yy: 126 } -- this is implemented in JS
	struct map_position_t {

		union {
			uint16_t id;
			struct {
				uint8_t xx, yy;
			};
		};

		map_position_t() {}

		map_position_t(uint8_t xx, uint8_t yy) : xx(xx), yy(yy) {}

		map_position_t(v8::Local<v8::Value> pos) {
			v8::Local<v8::Object> obj = Nan::To<v8::Object>(pos).ToLocalChecked();
			xx = Nan::To<uint32_t>(Nan::Get(obj, Nan::New("xx").ToLocalChecked()).ToLocalChecked()).FromJust();
			yy = Nan::To<uint32_t>(Nan::Get(obj, Nan::New("yy").ToLocalChecked()).ToLocalChecked()).FromJust();
		}

		bool operator< (map_position_t right) const {
			return this->id < right.id;
		}
	};

	//
	// Similar to a RoomPosition object, but stores coordinates in a continuous global plane.
	// Conversions to/from this coordinate plane are handled on the JS side
	class world_position_t {

		public:
			uint16_t xx, yy;

			enum direction_t { TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT };

			world_position_t() {}

			world_position_t(uint16_t xx, uint16_t yy) : xx(xx), yy(yy) {}

			world_position_t(v8::Local<v8::Value> pos) {
				v8::Local<v8::Object> obj = Nan::To<v8::Object>(pos).ToLocalChecked();
				xx = Nan::To<uint32_t>(Nan::Get(obj, Nan::New("xx").ToLocalChecked()).ToLocalChecked()).FromJust();
				yy = Nan::To<uint32_t>(Nan::Get(obj, Nan::New("yy").ToLocalChecked()).ToLocalChecked()).FromJust();
			}

			static world_position_t null() {
				return world_position_t(0, 0);
			}

			friend std::ostream& operator<< (std::ostream& os, const world_position_t& that) {
				int xx = that.xx / 50;
				int yy = that.yy / 50;
				bool w = xx <= 127;
				bool n = yy <= 127;
				os <<"world_position_t(["
					<<(w ? 'W' : 'E')
					<<(w ? 127 - xx : xx - 128)
					<<(n ? 'N' : 'S')
					<<(n ? 127 - yy : yy - 128)
					<<"] " <<that.xx % 50 <<", " <<that.yy % 50 <<")";
				return os;
			}

			bool operator!= (world_position_t right) const {
				return this->xx != right.xx || this->yy != right.yy;
			}

			bool is_null() const {
				return xx == 0 && yy == 0;
			}

			world_position_t position_in_direction(direction_t dir) const {
				switch (dir) {
					case TOP:
						return world_position_t(xx, yy - 1);
					case TOP_RIGHT:
						return world_position_t(xx + 1, yy - 1);
					case RIGHT:
						return world_position_t(xx + 1, yy);
					case BOTTOM_RIGHT:
						return world_position_t(xx + 1, yy + 1);
					case BOTTOM:
						return world_position_t(xx, yy + 1);
					case BOTTOM_LEFT:
						return world_position_t(xx - 1, yy + 1);
					case LEFT:
						return world_position_t(xx - 1, yy);
					case TOP_LEFT:
						return world_position_t(xx - 1, yy - 1);
				}
			}

			// Gets the linear direction to a tile
			direction_t direction_to(world_position_t pos) const {
				int8_t dx = pos.xx - this->xx;
				int8_t dy = pos.yy - this->yy;
				if (dx > 0) {
					if (dy > 0) {
						return BOTTOM_RIGHT;
					} else if (dy < 0) {
						return TOP_RIGHT;
					} else {
						return RIGHT;
					}
				} else if (dx < 0) {
					if (dy > 0) {
						return BOTTOM_LEFT;
					} else if (dy < 0) {
						return TOP_LEFT;
					} else {
						return LEFT;
					}
				} else {
					if (dy > 0) {
						return BOTTOM;
					} else if (dy < 0) {
						return TOP;
					}
				}
				return (direction_t)-1;
			}

			uint16_t range_to(const world_position_t pos) const {
				return std::max(
					pos.xx > this->xx ? pos.xx - this->xx : this->xx - pos.xx,
					pos.yy > this->yy ? pos.yy - this->yy : this->yy - pos.yy
				);
			}

			map_position_t map_position() const {
				return map_position_t(xx / 50, yy / 50);
			}
	};

	//
	// Simple open-closed list
	class open_closed_t {

		private:
			std::vector<unsigned int> list;
			unsigned int marker;

		public:
			open_closed_t(size_t size) : list(size), marker(1) {}

			void clear() {
				if (std::numeric_limits<unsigned int>::max() - 2 <= marker) {
					std::fill(list.begin(), list.end(), 0);
					marker = 1;
				} else {
					marker += 2;
				}
			}

			bool is_open(unsigned int index) const {
				return list[index] == marker;
			}

			bool is_closed(unsigned int index) const {
				return list[index] == marker + 1;
			}

			void open(unsigned int index) {
				list[index] = marker;
			}

			void close(unsigned int index) {
				list[index] = marker + 1;
			}
	};

	//
	// Stores context about a room, specific to each search
	struct room_info_t {
		uint8_t* terrain;
		uint8_t (*cost_matrix)[50];
		map_position_t pos;
		static uint8_t cost_matrix0[2500];

		room_info_t(uint8_t* terrain, uint8_t* cost_matrix, map_position_t pos) :
			terrain(terrain),
			cost_matrix((uint8_t(*)[50])(cost_matrix == NULL ? cost_matrix0 : cost_matrix)),
			pos(pos)
			{
		}

		uint8_t look(uint8_t xx, uint8_t yy) const {
			if (cost_matrix[xx][yy]) {
				return cost_matrix[xx][yy];
			}
			uint16_t index = xx * 50 + yy;
			return 0x03 & terrain[index / 4] >> (index % 4 * 2);
		}
	};

	//
	// Stores information about a pathfinding goal, just a position + range
	struct goal_t {
		uint8_t range;
		world_position_t pos;
		goal_t(v8::Local<v8::Value> goal) {
			v8::Local<v8::Object> obj = Nan::To<v8::Object>(goal).ToLocalChecked();
			range = Nan::To<uint32_t>(Nan::Get(obj, Nan::New("range").ToLocalChecked()).ToLocalChecked()).FromJust();
			pos = world_position_t(Nan::Get(obj, Nan::New("pos").ToLocalChecked()).ToLocalChecked());
		}
	};

	//
	// Priority queue implementation w/ support for updating priorities
	template <class index_t, class priority_t>
	class heap_t {

		private:
			std::vector<priority_t> priorities;
			std::vector<index_t> heap;
			size_t size_;

		public:
			heap_t(size_t max_size, size_t max_index) : priorities(max_index), heap(max_size), size_(0) {}

			priority_t min_priority() const {
				return priorities[heap[1]];
			}

			index_t min() const {
				return heap[1];
			}

			size_t size() const {
				return size_;
			}

			priority_t priority(index_t index) {
				return priorities[index];
			}

			void pop() {
				heap[1] = heap[size_];
				--size_;
				size_t vv = 1;
				do {
					size_t uu = vv;
					if ((uu << 1) + 1 <= size_) {
						if (priorities[heap[uu]] >= priorities[heap[uu << 1]]) {
							vv = uu << 1;
						}
						if (priorities[heap[vv]] >= priorities[heap[(uu << 1) + 1]]) {
							vv = (uu << 1) + 1;
						}
					} else if (uu << 1 <= size_) {
						if (priorities[heap[uu]] >= priorities[heap[uu << 1]]) {
							vv = uu << 1;
						}
					}
					if (uu != vv) {
						std::swap(heap[uu], heap[vv]);
					} else {
						return;
					}
				} while(true);
			}

			void push(index_t index, priority_t priority) {
				if (size_ == heap.size() - 1) {
					throw std::runtime_error("Max heap");
				}
				priorities[index] = priority;
				++size_;
				heap[size_] = index;
				bubble_up(size_);
			}

			void update(index_t index, priority_t priority) {
				for (size_t ii = size_; ii > 0; --ii) {
					if (heap[ii] == index) {
						priorities[index] = priority;
						bubble_up(ii);
						return;
					}
				}
			}

			void bubble_up(size_t ii) {
				while (ii != 1) {
					if (priorities[heap[ii]] <= priorities[heap[ii >> 1]]) {
						std::swap(heap[ii], heap[ii >> 1]);
						ii = ii >> 1;
					} else {
						return;
					}
				}
			}

			void clear() {
				size_ = 0;
			}
	};

	//
	// Path finder encapsulation. Multiple instances are thread-safe
	class path_finder_t {
		public:
			typedef uint32_t cost_t;
			typedef uint16_t pos_index_t;
			typedef uint8_t room_index_t;

		private:
			struct state_t {
				std::vector<room_info_t> room_table;
				std::vector<room_index_t> reverse_room_table;
				std::set<map_position_t> blocked_rooms;
				std::vector<pos_index_t> parents;
				open_closed_t open_closed;
				heap_t<pos_index_t, cost_t>heap;
				std::vector<goal_t> goals;
				cost_t plain_cost;
				cost_t swamp_cost;
				double heuristic_weight;
				uint8_t max_rooms;
				bool flee;
				v8::Local<v8::Value>* room_data_handles;
				v8::Local<v8::Function>* room_callback;

				state_t(size_t size) :
					reverse_room_table(1 << sizeof(map_position_t) * 8),
					parents(size),
					open_closed(size),
					heap(2500, size) {
				}
			};

			class state_manager_t {
				private:
					path_finder_t& pf;
					std::auto_ptr<state_t> state;

				public:
					state_manager_t(path_finder_t& that) : pf(that) {
						if (++pf.depth > 1) {
							state = std::auto_ptr<state_t>(new state_t(that.state));
						}
					}

					~state_manager_t() {
						if (--pf.depth >= 1) {
							pf.state = *state;
						}
					}
			};

			uint16_t depth;
			state_t state;

			static std::map<map_position_t, uint8_t*> terrain;

			class js_error: public std::runtime_error {
				public: js_error() : std::runtime_error("js error") {}
			};

		public:
			path_finder_t();

		private:
			room_index_t room_index_from_pos(const map_position_t map_pos);
			pos_index_t index_from_pos(const world_position_t pos);
			world_position_t pos_from_index(pos_index_t index) const;
			void push_node(pos_index_t parent_index, world_position_t node, cost_t g_cost);

			const cost_t obstacle = std::numeric_limits<cost_t>::max();
			cost_t look(const world_position_t pos);
			cost_t heuristic(const world_position_t pos) const;

			void astar(pos_index_t index, world_position_t pos, cost_t g_cost);

			world_position_t jump_x(cost_t cost, world_position_t pos, int8_t dx);
			world_position_t jump_y(cost_t cost, world_position_t pos, int8_t dx);
			world_position_t jump_xy(cost_t cost, world_position_t pos, int8_t dx, int8_t dy);
			world_position_t jump(cost_t cost, world_position_t pos, int8_t dx, int8_t dy);
			void jps(pos_index_t index, world_position_t pos, cost_t g_cost);
			void jump_neighbor(world_position_t pos, pos_index_t index, world_position_t neighbor, cost_t g_cost, cost_t cost, cost_t n_cost);

		public:
			v8::Local<v8::Value> search(
				v8::Local<v8::Value> origin_js, v8::Local<v8::Array> goals_js,
				v8::Local<v8::Function> room_callback,
				cost_t plain_cost, cost_t swamp_cost,
				uint8_t max_rooms, uint32_t max_ops, uint32_t max_cost,
				bool flee,
				double heuristic_weight
			);
			void load_terrain(v8::Local<v8::Array> terrain);
	};
};
