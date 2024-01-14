mod utils;

// use std::{fs::File, io::Read};

use tiff::decoder::ifd::Value;
use tiff::decoder::Decoder;
use tiff::decoder::DecodingResult;
use tiff::tags::Tag;
use tiff::TiffError;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{console, Request, RequestInit};

// use rand::Rng;
extern crate geotiff;
// use geotiff::TIFF;
// use rand::Rng;
use std::io::{Cursor, Seek, SeekFrom, Write};
// use std::error::Error;
// use wasm_bindgen::JsCast;
// use web_sys::{Request, RequestInit, Response};

#[cfg(feature = "console_error_panic_hook")]
use console_error_panic_hook;

use std::collections::HashMap;
use std::vec;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global
// allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    height: u32,
}

#[wasm_bindgen]
pub struct Universe {
    width: u32,
    height: u32,
    cells: Vec<Cell>,
    water_cell_locations: Vec<(u32, u32)>,
    max_height: u32,
    min_height: u32,
    // model_tie_point_tag: Result<Option<Value>, TiffError>,
    // model_pixel_scale_tag: Result<Option<Value>, TiffError>,
    // geokey_directory_tag: Result<Option<Value>, TiffError>,
}

#[wasm_bindgen]
impl Universe {
    pub fn handle_user_input(&mut self, row: f64, col: f64) {
        self.water_cell_locations.push((row as u32, col as u32))
    }
    pub fn tick(&mut self) {
        let mut next_water_cell_locations = self.water_cell_locations.clone();
        for (index, cell_location) in self.water_cell_locations.clone().iter().enumerate() {
            let flow_direction = self.calculate_flow_direction(cell_location.0, cell_location.1);
            let new_cell_location = self.calculate_next_position_from_direction(
                cell_location.0,
                cell_location.1,
                flow_direction,
            );
            next_water_cell_locations.remove(index);
            next_water_cell_locations.insert(index, new_cell_location);
        }
        self.water_cell_locations = next_water_cell_locations
    }
    fn calculate_flow_direction(&mut self, row: u32, column: u32) -> String {
        let error_message = String::from("Calculate flow direction error!");
        let current_cell_height = self
            .get_cell_value(row as i32, column as i32)
            .expect(&error_message) as i32;
        let mut scores = HashMap::new();
        let w = self.get_cell_value(row as i32, (column as i32) - 1);
        let nw = self.get_cell_value(row as i32 - 1, (column as i32) - 1);
        let n = self.get_cell_value(row as i32 - 1, column as i32);
        let ne = self.get_cell_value(row as i32 - 1, (column as i32) + 1);
        let e = self.get_cell_value(row as i32, (column as i32) + 1);
        let se = self.get_cell_value(row as i32 + 1, (column as i32) + 1);
        let s = self.get_cell_value(row as i32 + 1, column as i32);
        let sw = self.get_cell_value(row as i32 + 1, (column as i32) - 1);

        if w != None {
            scores.insert("w", current_cell_height - (w.expect(&error_message) as i32));
        }
        if nw != None {
            scores.insert(
                "nw",
                current_cell_height - (nw.expect(&error_message) as i32),
            );
        }
        if n != None {
            scores.insert("n", current_cell_height - (n.expect(&error_message) as i32));
        }
        if ne != None {
            scores.insert(
                "ne",
                current_cell_height - (ne.expect(&error_message) as i32),
            );
        }
        if e != None {
            scores.insert("e", current_cell_height - (e.expect(&error_message) as i32));
        }
        if se != None {
            scores.insert(
                "se",
                current_cell_height - (se.expect(&error_message) as i32),
            );
        }
        if s != None {
            scores.insert("s", current_cell_height - (s.expect(&error_message) as i32));
        }
        if sw != None {
            scores.insert(
                "sw",
                current_cell_height - (sw.expect(&error_message) as i32),
            );
        }
        let key_value_with_max_value = scores.iter().max_by_key(|entry| entry.1).unwrap();
        if *key_value_with_max_value.1 <= 0 {
            return "".to_string();
        }
        key_value_with_max_value.0.to_string()
    }
    pub async fn new() -> Universe {
        let data = Self::fetch_srtm_data()
            .await
            .expect("Can't fetch SRTM data.");
        let cells: Vec<Cell> = data.iter().map(|d| Cell { height: *d as u32 }).collect();
        let s = 50;
        let width = s;
        let height = s;
        let max_height = data.iter().map(|x| *x as u32).max().unwrap();
        let min_height = data.iter().map(|x| *x as u32).min().unwrap();
        let water_cell_locations = vec![(49, 49), (48, 48), (47, 47), (46, 46), (45, 45)];
        // let model_tie_point_tag = data.1;
        // let model_pixel_scale_tag = data.2;
        // let geokey_directory_tag = data.3;
        Universe {
            width,
            height,
            cells,
            water_cell_locations,
            min_height,
            max_height,
            // model_tie_point_tag,
            // model_pixel_scale_tag,
            // geokey_directory_tag,
        }
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn cells(&self) -> *const Cell {
        self.cells.as_ptr()
    }
    pub fn water_cell_locations(&self) -> *const (u32, u32) {
        self.water_cell_locations.as_ptr()
    }
    pub fn water_cells_count(&self) -> usize {
        self.water_cell_locations.len()
    }
    pub fn min_height(&self) -> u32 {
        self.min_height
    }
    pub fn max_height(&self) -> u32 {
        self.max_height
    }
    // pub fn model_tie_point_tag(&self) -> u32 {
        // self.model_tie_point_tag.ok().ok_or("err")
        // let inner_option = self.model_tie_point_tag.as_ref().ok().ok_or("Outer Option is None");
        // let value = inner_option.ok().ok_or("Inner Option is None");
        // match value {
        //     Value::Byte(d) => Ok(*d as u32),
        //     Value::Short(d) => Ok(*d as u32),
        //     Value::Signed(d) => Ok(*d as u32),
        //     Value::SignedBig(d) => Ok(*d as u32), // Be cautious of overflow
        //     Value::Unsigned(d) => Ok(*d),
        //     Value::UnsignedBig(d) => Ok(*d as u32), // Be cautious of overflow
        //     Value::Float(d) => Ok(*d as u32),  // Note: you're losing decimal info
        //     Value::Double(d) => Ok(*d as u32), // Note: you're losing decimal info
        //     Value::Rational(n, _) => Ok(*n),  // Note: you're losing the denominator
        //     Value::RationalBig(n, _) => Ok(*n as u32), // Be cautious of overflow
        //     Value::SRational(n, _) => Ok(*n as u32), // Be cautious if n is negative
        //     Value::SRationalBig(n, _) => Ok(*n as u32), // Be cautious if n is negative or too large
        //     Value::Ifd(d) => Ok(*d),
        //     Value::IfdBig(d) => Ok(*d as u32), // Be cautious of overflow
        //     // Handle the cases that don't logically convert to u32
        //     _ => Err("Cannot convert this type to u32"),
        // }
    // }
    pub fn get_cell_value(&mut self, row: i32, column: i32) -> Option<u32> {
        if row >= 0 && column >= 0 && row < self.width as i32 && column < self.height as i32 {
            let idx = self.get_index(row as u32, column as u32);
            return Some(self.cells[idx].height);
        } else {
            return None;
        }
    }
    fn get_index(&self, row: u32, column: u32) -> usize {
        (row * self.width + column) as usize
    }
    fn calculate_next_position_from_direction(
        &self,
        row: u32,
        column: u32,
        direction: String,
    ) -> (u32, u32) {
        let new_position = match direction.as_str() {
            "w" => (row, column - 1),
            "nw" => (row - 1, column - 1),
            "n" => (row - 1, column),
            "ne" => (row - 1, column + 1),
            "e" => (row, column + 1),
            "se" => (row + 1, column + 1),
            "s" => (row + 1, column),
            "sw" => (row + 1, column - 1),
            "" => (row, column),
            &_ => todo!(),
        };
        new_position
    }
    async fn fetch_srtm_data(// north: f64,
        // south: f64,
        // east: f64,
        // west: f64,
    ) -> Result<Vec<i32>, Box<dyn std::error::Error>> {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();
        // construct the URL for the USGS API request
        // let url = format!(
        //     "https://earthexplorer.usgs.gov/inventory/json/v/1.4.0/datasets/SRTM/1_Arc_Second/Metadata?north={}&south={}&east={}&west={}",
        //     north, south, east, west
        // );
        let url = String::from(
            "https://wasm-water-simulation.s3.eu-central-1.amazonaws.com/public/small_sakarya2.tif",
        );
        let window = web_sys::window().unwrap();
        let mut opts = RequestInit::new();
        opts.method("GET");
        let request = Request::new_with_str_and_init(&url, &opts).expect("Request Error!");
        let resp_value = JsFuture::from(window.fetch_with_request(&request))
            .await
            .expect("Fetching data");
        let resp: web_sys::Response = resp_value.dyn_into().expect("Dny");

        let resp_array_buffer = JsFuture::from(resp.array_buffer().expect("to Buffer error"))
            .await
            .expect("async op error");
        let data = js_sys::Uint8Array::new(&resp_array_buffer).to_vec();

        let mut cursor = Cursor::new(Vec::new());
        cursor.write_all(&data[..])?;
        cursor.seek(SeekFrom::Start(0))?;

        let mut decoder = Decoder::new(cursor)?;
        let decoding_result = decoder.read_image()?;

        // let model_tie_point_tag: Result<Option<Value>, TiffError> = decoder.find_tag(Tag::ModelTiepointTag);
        let model_pixel_scale_tag: Result<Option<Value>, TiffError> = decoder.find_tag(Tag::ModelPixelScaleTag);
        let geokey_directory_tag: Result<Option<Value>, TiffError> = decoder.find_tag(Tag::GeoKeyDirectoryTag);

        let vec_image: Vec<i32> = match decoding_result {
            DecodingResult::U8(image_data) => image_data
                .into_iter()
                .map(|pixel| {
                    let pixel_value = pixel as i32;
                    pixel_value
                })
                .collect(),
            DecodingResult::U16(image_data) => image_data
                .into_iter()
                .map(|pixel| {
                    let pixel_value = pixel as i32;
                    pixel_value
                })
                .collect(),
            DecodingResult::I16(image_data) => image_data
                .into_iter()
                .map(|pixel| {
                    let pixel_value = pixel as i32;
                    pixel_value
                })
                .collect(),
            // Handle other pixel data types or return an error if unsupported.
            unsupported => {
                console::log_1(&format!("Unsupported pixel data type: {:?}", unsupported).into());
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Unsupported pixel data type",
                )));
            }
        };
        Ok(vec_image)
    }
}
