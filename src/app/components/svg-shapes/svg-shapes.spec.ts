import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SvgShapes } from './svg-shapes';

describe('SvgShapes', () => {
  let component: SvgShapes;
  let fixture: ComponentFixture<SvgShapes>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SvgShapes],
    }).compileComponents();

    fixture = TestBed.createComponent(SvgShapes);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
